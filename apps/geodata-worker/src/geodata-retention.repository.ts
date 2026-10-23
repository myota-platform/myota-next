import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { isTransientDatabaseError } from '@app/platform/database-retry.js';

type ImportSource = { bucket: string; key: string } | null;

@Injectable()
export class GeodataRetentionRepository {
  private readonly logger = new Logger(GeodataRetentionRepository.name);
  private storage?: S3Client;

  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async purgeSweep(): Promise<{
    eligible: number;
    purged: number;
    failed: number;
    uploadsExpired: number;
  }> {
    const retentionDays = positiveInteger(
      process.env.GEODATA_IMPORT_RETENTION_DAYS,
      30,
    );
    const batchSize = positiveInteger(
      process.env.GEODATA_IMPORT_RETENTION_BATCH_SIZE,
      100,
    );
    const excluded = new Set<string>();
    const total = { eligible: 0, purged: 0, failed: 0, uploadsExpired: 0 };
    while (true) {
      const result = await this.purgeBatch(retentionDays, batchSize, [
        ...excluded,
      ]);
      total.eligible += result.eligible;
      total.purged += result.purged;
      total.failed += result.failed.length;
      result.failed.forEach((item) => excluded.add(item));
      if (result.eligible < batchSize || result.purged === 0) break;
    }
    total.uploadsExpired = await this.expireUploadSessions(batchSize);
    return total;
  }

  private async purgeBatch(days: number, limit: number, excluded: string[]) {
    const client = await this.connect();
    try {
      const rows = await client.query(
        `SELECT id::text,source_metadata FROM import_run WHERE
           ((status='PROCESSED' AND processed_at<now()-($1*interval '1 day')) OR
            (status IN ('UPLOAD_PENDING','QUEUED','PROCESSING','CANCELLING','CANCELLED',
              'PREPROCESSED','PREPROCESSED_WITH_ERRORS','COMPLETED','COMPLETED_WITH_ERRORS','FAILED')
             AND GREATEST(started_at,COALESCE(heartbeat_at,'-infinity'::timestamptz),
               COALESCE(completed_at,'-infinity'::timestamptz))<now()-($1*interval '1 day')))
           AND NOT (id=ANY($2::uuid[]))
         ORDER BY CASE WHEN status='PROCESSED' THEN processed_at ELSE
           GREATEST(started_at,COALESCE(heartbeat_at,'-infinity'::timestamptz),
             COALESCE(completed_at,'-infinity'::timestamptz)) END,id LIMIT $3`,
        [days, excluded, limit],
      );
      let purged = 0;
      const failed: string[] = [];
      for (const row of rows.rows) {
        try {
          const source = importSource(
            row.source_metadata,
            String(
              process.env.MYOTA_GEODATA_IMPORT_BUCKET ??
                'myota-geodata-imports',
            ),
          );
          if (source)
            await this.s3().send(
              new DeleteObjectCommand({
                Bucket: source.bucket,
                Key: source.key,
              }),
            );
          if (await this.deleteRun(client, row.id, days)) purged++;
        } catch (error) {
          if (isTransientDatabaseError(error)) throw error;
          failed.push(String(row.id));
          this.logger.error(
            `Failed to purge expired Geodata import ${row.id}: ${safeError(error)}`,
          );
        }
      }
      return { eligible: rows.rowCount ?? rows.rows.length, purged, failed };
    } finally {
      client.release();
    }
  }

  private async deleteRun(
    client: PoolClient,
    runId: string,
    days: number,
  ): Promise<boolean> {
    await client.query('BEGIN');
    try {
      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      const eligible = await client.query(
        `SELECT id FROM import_run WHERE id=$1 AND
           ((status='PROCESSED' AND processed_at<now()-($2*interval '1 day')) OR
            (status IN ('UPLOAD_PENDING','QUEUED','PROCESSING','CANCELLING','CANCELLED',
              'PREPROCESSED','PREPROCESSED_WITH_ERRORS','COMPLETED','COMPLETED_WITH_ERRORS','FAILED')
             AND GREATEST(started_at,COALESCE(heartbeat_at,'-infinity'::timestamptz),
               COALESCE(completed_at,'-infinity'::timestamptz))<now()-($2*interval '1 day')))
         FOR UPDATE`,
        [runId, days],
      );
      if (!eligible.rowCount) {
        await client.query('COMMIT');
        return false;
      }
      const events = await client.query(
        `SELECT event_id FROM outbox_event WHERE aggregate_type='import_run' AND aggregate_id=$1
           AND published_at IS NOT NULL AND occurred_at<now()-($2*interval '1 day')
           AND NOT EXISTS (SELECT 1 FROM dead_letter_event d
             WHERE d.event_id=outbox_event.event_id AND d.resolved_at IS NULL)`,
        [runId, days],
      );
      const eventIds = events.rows.map((row) => row.event_id);
      if (eventIds.length) {
        await client.query(
          'DELETE FROM consumer_processed_event WHERE event_id=ANY($1::uuid[])',
          [eventIds],
        );
        await client.query(
          'DELETE FROM dead_letter_event WHERE event_id=ANY($1::uuid[])',
          [eventIds],
        );
        await client.query(
          'DELETE FROM outbox_event WHERE event_id=ANY($1::uuid[])',
          [eventIds],
        );
      }
      await client.query(
        'DELETE FROM source_snapshot_manifest WHERE import_run_id=$1',
        [runId],
      );
      const deleted = await client.query('DELETE FROM import_run WHERE id=$1', [
        runId,
      ]);
      if (deleted.rowCount !== 1)
        throw new Error('eligible import run disappeared during retention');
      await client.query(
        "DELETE FROM geodata_audit_event WHERE aggregate_type='import_run' AND aggregate_id=$1",
        [runId],
      );
      await client.query(
        "DELETE FROM geodata_control_record WHERE kind='sourceManifests' AND id=$1",
        [runId],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  private async expireUploadSessions(batchSize: number): Promise<number> {
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT id::text,bucket,object_key,multipart_upload_id FROM geodata_upload_session
         WHERE status IN ('UPLOADING','COMPLETING') AND expires_at<=now()
         ORDER BY expires_at LIMIT $1`,
        [batchSize],
      );
      const expired: string[] = [];
      for (const row of result.rows) {
        try {
          await this.s3().send(
            new AbortMultipartUploadCommand({
              Bucket: String(row.bucket),
              Key: String(row.object_key),
              UploadId: String(row.multipart_upload_id),
            }),
          );
          expired.push(String(row.id));
        } catch (error) {
          this.logger.error(
            `Failed to abort expired Geodata upload ${row.id}: ${safeError(error)}`,
          );
        }
      }
      if (expired.length) {
        await client.query('BEGIN');
        try {
          await client.query(
            "SELECT set_config('myota.geodata_writer','row-v1',true)",
          );
          await client.query(
            `UPDATE geodata_upload_session SET status='EXPIRED',updated_at=now()
             WHERE id=ANY($1::uuid[]) AND status IN ('UPLOADING','COMPLETING')`,
            [expired],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        }
      }
      await client.query('BEGIN');
      try {
        await client.query(
          "SELECT set_config('myota.geodata_writer','row-v1',true)",
        );
        await client.query(
          `DELETE FROM geodata_upload_session WHERE status IN ('ABORTED','EXPIRED')
           AND updated_at<now()-interval '30 days'`,
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
      return expired.length;
    } finally {
      client.release();
    }
  }

  private async connect(): Promise<PoolClient> {
    if (!this.pool)
      throw new ServiceUnavailableException(
        'Geodata database is not configured',
      );
    try {
      return await this.pool.connect();
    } catch (error) {
      throw new ServiceUnavailableException('Geodata database is unavailable', {
        cause: error,
      });
    }
  }

  private s3() {
    if (!this.storage) {
      this.storage = new S3Client({
        endpoint:
          process.env.MYOTA_OBJECT_STORAGE_ENDPOINT ?? 'http://seaweedfs:8333',
        region: process.env.MYOTA_OBJECT_STORAGE_REGION ?? 'us-east-1',
        forcePathStyle:
          (process.env.MYOTA_OBJECT_STORAGE_ADDRESSING_STYLE ?? 'path') ===
          'path',
        credentials: {
          accessKeyId:
            process.env.MYOTA_OBJECT_STORAGE_ACCESS_KEY ?? 'myota-s3',
          secretAccessKey:
            process.env.MYOTA_OBJECT_STORAGE_SECRET_KEY ?? 'myota-s3-dev-only',
        },
      });
    }
    return this.storage;
  }
}

function importSource(metadata: unknown, importBucket: string): ImportSource {
  let value = metadata;
  if (typeof value === 'string') value = JSON.parse(value);
  if (!isRecord(value))
    throw new Error('import source metadata is not an object');
  const source = value.source;
  if (!isRecord(source)) return null;
  const key = source.objectKey;
  let bucket = source.bucket;
  if (!bucket && key) bucket = importBucket;
  if (!key) return null;
  if (bucket !== importBucket)
    throw new Error(
      'import source points outside the configured import bucket',
    );
  if (
    !importBucket ||
    /[\\/]/.test(importBucket) ||
    ['.', '..'].includes(importBucket)
  )
    throw new Error('configured import bucket is unsafe');
  if (
    typeof key !== 'string' ||
    !key.trim() ||
    key.startsWith('/') ||
    key.includes('\\') ||
    key.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('unsafe import object key');
  return { bucket: importBucket, key };
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1)
    throw new Error('Geodata retention settings must be positive integers');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 300);
}
