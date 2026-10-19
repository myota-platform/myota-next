import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';

@Injectable()
export class ActivityRetentionRepository {
  private readonly logger = new Logger(ActivityRetentionRepository.name);
  private storage?: S3Client;

  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async runSweep(): Promise<number> {
    const bucket = process.env.MYOTA_ADIF_BUCKET ?? 'myota-adif';
    const days = positiveInteger(process.env.MYOTA_ADIF_RETENTION_DAYS, 15);
    const batchSize = positiveInteger(
      process.env.MYOTA_ADIF_RETENTION_BATCH_SIZE,
      500,
    );
    let deleted = 0;
    while (true) {
      const client = await this.connect();
      let rows: { id: string; bucket: string; object_key: string }[];
      try {
        const result = await client.query(
          `SELECT id::text,bucket,object_key FROM activity_import
           WHERE status IN ('COMPLETED','FAILED')
             AND completed_at<now()-($1*interval '1 day')
             AND source_deleted_at IS NULL AND bucket=$2
           ORDER BY completed_at,id LIMIT $3`,
          [days, bucket, batchSize],
        );
        rows = result.rows;
      } finally {
        client.release();
      }
      if (!rows.length) return deleted;

      const failures: string[] = [];
      for (const row of rows) {
        try {
          if (row.bucket !== bucket)
            throw new Error(
              'refusing to delete an object outside the ADIF bucket',
            );
          if (!safeObjectKey(row.object_key))
            throw new Error('refusing to delete an unsafe ADIF object key');
          await this.s3().send(
            new DeleteObjectCommand({ Bucket: bucket, Key: row.object_key }),
          );
          const update = await this.connect();
          try {
            await update.query(
              `UPDATE activity_import SET source_deleted_at=now()
               WHERE id=$1 AND source_deleted_at IS NULL`,
              [row.id],
            );
          } finally {
            update.release();
          }
          deleted++;
        } catch (error) {
          failures.push(row.id);
          this.logger.error(
            `ADIF source cleanup failed for import ${row.id}: ${safeError(error)}`,
          );
        }
      }
      if (failures.length)
        throw new Error(
          `could not delete ADIF source objects for imports: ${failures.slice(0, 10).join(', ')}`,
        );
      if (rows.length < batchSize) return deleted;
    }
  }

  private async connect(): Promise<PoolClient> {
    if (!this.pool)
      throw new ServiceUnavailableException(
        'Activity database is not configured',
      );
    return this.pool.connect();
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

function positiveInteger(raw: string | undefined, fallback: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1)
    throw new Error('ADIF retention settings must be positive integers');
  return value;
}

function safeObjectKey(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.split('/').some((part) => !part || part === '.' || part === '..')
  );
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 300);
}
