import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import {
  AbortMultipartUploadCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { GeodataUploadService } from './geodata-upload.service.js';

const enabled =
  process.env.MYOTA_GEO_STORAGE_RECOVERY_TEST === '1' &&
  Boolean(process.env.GEO_DATABASE_URL);

describe.skipIf(!enabled)('Geodata object-store recovery', () => {
  it('retries a multipart part after SeaweedFS restarts with its data volume', async () => {
    const databaseUrl = process.env.GEO_DATABASE_URL;
    const endpoint = process.env.MYOTA_OBJECT_STORAGE_ENDPOINT;
    const bucket = process.env.MYOTA_GEODATA_IMPORT_BUCKET;
    const container = process.env.MYOTA_S3_RECOVERY_CONTAINER;
    const dataDirectory = process.env.MYOTA_S3_RECOVERY_DATA_DIRECTORY;
    const accessKey = process.env.MYOTA_OBJECT_STORAGE_ACCESS_KEY;
    const secretKey = process.env.MYOTA_OBJECT_STORAGE_SECRET_KEY;
    if (
      !databaseUrl ||
      !endpoint ||
      !bucket ||
      !container ||
      !dataDirectory ||
      !accessKey ||
      !secretKey
    )
      throw new Error('object-store recovery settings are required');
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(
        new URL(databaseUrl).hostname,
      )
    )
      throw new Error('object-store recovery requires local Postgres');
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname)
    )
      throw new Error('object-store recovery requires local SeaweedFS');

    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const client = new S3Client({
      endpoint,
      region: process.env.MYOTA_OBJECT_STORAGE_REGION ?? 'us-east-1',
      forcePathStyle: true,
      maxAttempts: 1,
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    });
    const id = randomUUID();
    const owner = `object-recovery-${id}`;
    const filename = `${id}.geojson`;
    const firstBody = Buffer.alloc(5 * 1024 * 1024, 0x20);
    const lastBody = Buffer.from(
      '{"type":"FeatureCollection","features":[]}',
      'utf8',
    );
    const body = Buffer.concat([firstBody, lastBody]);
    const service = new GeodataUploadService(pool as Pool);
    let uploadId: string | undefined;
    let lostVolumeUploadId: string | undefined;
    let operationError: unknown;

    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      const created = await service.create(owner, id, {
        adapter: 'MANUAL',
        source: { name: 'SeaweedFS recovery fixture' },
        filename,
        format: 'GEOJSON',
        expectedSize: body.length,
        entityTypes: ['TEST_PARK'],
      });
      uploadId = created.uploadId;

      const firstPart = await service.uploadPart(owner, uploadId, 1, firstBody);
      expect(firstPart.sizeBytes).toBe(firstBody.length);

      runDocker('stop', container);
      await expect(
        service.uploadPart(owner, uploadId, 2, lastBody),
      ).rejects.toBeDefined();

      const afterFailure = await pool.query(
        `SELECT count(*)::int AS count FROM geodata_upload_part
         WHERE upload_session_id=$1 AND part_number=2`,
        [uploadId],
      );
      expect(afterFailure.rows[0]?.count).toBe(0);

      runDocker('start', container);
      await waitForSeaweedFS(endpoint);

      const retriedPart = await service.uploadPart(
        owner,
        uploadId,
        2,
        lastBody,
      );
      expect(retriedPart).toMatchObject({
        uploadId,
        partNumber: 2,
        sizeBytes: lastBody.length,
      });
      const completed = await service.complete(owner, uploadId);
      expect(completed).toMatchObject({ uploadId, status: 'COMPLETED' });

      const stored = await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: `geodata-imports/${uploadId}-${filename}`,
        }),
      );
      const bytes = await stored.Body?.transformToByteArray();
      expect(Buffer.from(bytes ?? [])).toEqual(body);

      const persisted = await pool.query(
        `SELECT session.status,run.status AS run_status,
                count(part.part_number)::int AS part_count
         FROM geodata_upload_session session
         LEFT JOIN import_run run ON run.id=session.import_run_id
         LEFT JOIN geodata_upload_part part ON part.upload_session_id=session.id
         WHERE session.id=$1
         GROUP BY session.id,run.id`,
        [uploadId],
      );
      expect(persisted.rows[0]).toMatchObject({
        status: 'COMPLETED',
        run_status: 'QUEUED',
        part_count: 2,
      });

      const doomedUpload = await service.create(owner, `${id}-volume-loss`, {
        adapter: 'MANUAL',
        source: { name: 'SeaweedFS lost-volume fixture' },
        filename: `lost-${filename}`,
        format: 'GEOJSON',
        expectedSize: body.length,
        entityTypes: ['TEST_PARK'],
      });
      lostVolumeUploadId = doomedUpload.uploadId;
      await service.uploadPart(owner, lostVolumeUploadId, 1, firstBody);
      await service.uploadPart(owner, lostVolumeUploadId, 2, lastBody);

      runDocker('stop', container);
      await replaceStorageDirectory(dataDirectory);
      runDocker('start', container);
      await waitForSeaweedFS(endpoint);
      await client.send(new CreateBucketCommand({ Bucket: bucket }));

      await expect(service.complete(owner, lostVolumeUploadId)).rejects.toThrow(
        'object storage lost the multipart upload; start a new upload',
      );
      const lostVolumeState = await pool.query(
        `SELECT session.status,session.import_run_id,
                (SELECT count(*)::int FROM import_run WHERE id=session.id) AS runs,
                (SELECT count(*)::int FROM outbox_event
                 WHERE event_type='geodata.import.queued.v1'
                   AND aggregate_id=session.id::text) AS queued_events
         FROM geodata_upload_session session WHERE session.id=$1`,
        [lostVolumeUploadId],
      );
      expect(lostVolumeState.rows[0]).toMatchObject({
        status: 'FAILED',
        import_run_id: null,
        runs: 0,
        queued_events: 0,
      });
    } catch (error) {
      operationError = error;
    }

    let cleanupError: unknown;
    try {
      for (const cleanupUploadId of [uploadId, lostVolumeUploadId]) {
        if (!cleanupUploadId) continue;
        const run = await pool.query(
          `SELECT import_run_id::text AS id,object_key,
                  multipart_upload_id FROM geodata_upload_session WHERE id=$1`,
          [cleanupUploadId],
        );
        const runId = run.rows[0]?.id as string | undefined;
        const objectKey = run.rows[0]?.object_key as string | undefined;
        const multipartUploadId = run.rows[0]?.multipart_upload_id as
          string | undefined;
        if (objectKey)
          await client
            .send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }))
            .catch(() => undefined);
        if (objectKey && multipartUploadId)
          await client
            .send(
              new AbortMultipartUploadCommand({
                Bucket: bucket,
                Key: objectKey,
                UploadId: multipartUploadId,
              }),
            )
            .catch(() => undefined);
        const cleanup = await pool.connect();
        let transactionError: unknown;
        try {
          await cleanup.query('BEGIN');
          await cleanup.query(
            "SELECT set_config('myota.geodata_writer','row-v1',true)",
          );
          if (runId) {
            await cleanup.query(
              'DELETE FROM outbox_event WHERE aggregate_id=$1',
              [runId],
            );
            await cleanup.query('DELETE FROM import_run WHERE id=$1', [runId]);
          }
          await cleanup.query(
            'DELETE FROM geodata_upload_session WHERE id=$1',
            [cleanupUploadId],
          );
          await cleanup.query('COMMIT');
        } catch (error) {
          await cleanup.query('ROLLBACK').catch(() => undefined);
          transactionError = error;
        }
        cleanup.release();
        if (transactionError) throw transactionError;
      }
    } catch (error) {
      cleanupError = error;
    }
    client.destroy();
    await pool.end();
    if (operationError) throw operationError;
    if (cleanupError) throw cleanupError;
  }, 90_000);
});

function runDocker(command: 'start' | 'stop', container: string) {
  const result = spawnSync('docker', [command, container], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `docker ${command} failed: ${result.stderr || result.stdout}`,
    );
}

async function replaceStorageDirectory(dataDirectory: string) {
  await rm(dataDirectory, { recursive: true, force: true });
  await mkdir(dataDirectory, { recursive: true, mode: 0o755 });
}

async function waitForSeaweedFS(endpoint: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('/status', endpoint), {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
    } catch {
      // Retry while the container and S3 gateway start.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('SeaweedFS did not become ready after restart');
}
