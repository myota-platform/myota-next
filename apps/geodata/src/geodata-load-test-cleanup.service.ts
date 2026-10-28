import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import {
  verifyAccessToken,
  type AccessTokenClaims,
} from '@app/platform/access-token.js';

const testRunPattern = /^lt-[A-Za-z0-9._-]{1,77}$/;
const terminalUploadStates = new Set([
  'COMPLETED',
  'ABORTED',
  'FAILED',
  'EXPIRED',
]);
const loadTestCleanupEnvironments = new Set([
  'development',
  'test',
  'testing',
  'staging',
  'production',
]);

export function isLoadTestCleanupEnabled(
  environment: string,
  enabled: string | undefined,
) {
  return (
    enabled === '1' &&
    loadTestCleanupEnvironments.has(environment.toLowerCase())
  );
}

type TaggedObject = { bucket: string; key: string };

@Injectable()
export class GeodataLoadTestCleanupService {
  private storage: S3Client | undefined;

  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async clean(
    authorization: string | undefined,
    testRunId: string,
    body: Record<string, unknown>,
  ) {
    const claims = verifyAccessToken(authorization);
    this.authorizeCleanup(claims);
    this.verifyEnvironment();
    if (!testRunPattern.test(testRunId))
      throw new BadRequestException(
        'testRunId must be a generated lt- fixture identifier',
      );
    if (body.confirmation !== `DELETE LOAD TEST DATA ${testRunId}`)
      throw new BadRequestException(
        'confirmation must exactly match DELETE LOAD TEST DATA <testRunId>',
      );

    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const runsResult = await client.query(
        `SELECT id::text,status,source_metadata FROM import_run
         WHERE source_metadata #>> '{source,loadTestRunId}'=$1 FOR UPDATE`,
        [testRunId],
      );
      const runs = runsResult.rows as Array<{
        id: string;
        status: string;
        source_metadata: Record<string, unknown>;
      }>;
      const runIds = runs.map((run) => run.id);
      if (
        runs.some((run) =>
          ['UPLOAD_PENDING', 'QUEUED', 'PROCESSING', 'CANCELLING'].includes(
            String(run.status).toUpperCase(),
          ),
        )
      )
        throw new BadRequestException(
          'load-test runs must finish or fail before cleanup can remove them',
        );

      const queuesResult = runIds.length
        ? await client.query(
            `SELECT id::text,status FROM geodata_import_processing_queue
             WHERE import_run_id=ANY($1::uuid[]) FOR UPDATE`,
            [runIds],
          )
        : { rows: [] };
      const queues = queuesResult.rows as Array<{
        id: string;
        status: string;
      }>;
      if (
        queues.some((queue) =>
          ['QUEUED', 'PROCESSING'].includes(String(queue.status).toUpperCase()),
        )
      )
        throw new BadRequestException(
          'load-test promotion queues must finish before cleanup can remove them',
        );

      const uploadsResult = await client.query(
        `SELECT id::text,bucket,object_key,status FROM geodata_upload_session
         WHERE metadata #>> '{source,loadTestRunId}'=$1 FOR UPDATE`,
        [testRunId],
      );
      const uploads = uploadsResult.rows as Array<{
        id: string;
        bucket: string;
        object_key: string;
        status: string;
      }>;
      if (
        uploads.some(
          (upload) =>
            !terminalUploadStates.has(String(upload.status).toUpperCase()),
        )
      )
        throw new BadRequestException(
          'load-test uploads must finish or be aborted before cleanup can remove them',
        );

      const entitiesResult = runIds.length
        ? await client.query(
            `SELECT id::text FROM geodata_entity
             WHERE public_properties #>> '{provenance,importRunId}'=ANY($1::text[])
               AND public_properties #>> '{provenance,source,loadTestRunId}'=$2
             FOR UPDATE`,
            [runIds, testRunId],
          )
        : { rows: [] };
      const entityIds = (entitiesResult.rows as Array<{ id: string }>).map(
        (row) => row.id,
      );
      const objects = this.taggedObjects(runs, uploads);
      const importBucket =
        process.env.MYOTA_GEODATA_IMPORT_BUCKET ?? 'myota-geodata-imports';
      if (objects.some((object) => object.bucket !== importBucket))
        throw new BadRequestException(
          'load-test cleanup refuses to delete an object outside the geodata import bucket',
        );

      await this.assertNoActivityImpact(authorization as string, entityIds);
      for (const object of objects)
        await this.storageClient().send(
          new DeleteObjectCommand({ Bucket: object.bucket, Key: object.key }),
        );

      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      const aggregateIds = [
        ...runIds,
        ...entityIds,
        ...queues.map((queue) => queue.id),
      ];
      if (entityIds.length) {
        await client.query(
          `DELETE FROM conflation_candidate
           WHERE left_entity_id=ANY($1::uuid[]) OR right_entity_id=ANY($1::uuid[])
              OR survivor_entity_id=ANY($1::uuid[])`,
          [entityIds],
        );
        await client.query(
          'DELETE FROM geodata_edit_staging WHERE entity_id=ANY($1::uuid[])',
          [entityIds],
        );
        await client.query(
          'DELETE FROM entity_review WHERE entity_id=ANY($1::uuid[])',
          [entityIds],
        );
        await client.query(
          'DELETE FROM geodata_entity_category WHERE entity_id=ANY($1::uuid[])',
          [entityIds],
        );
        await client.query(
          'DELETE FROM source_reference WHERE entity_id=ANY($1::uuid[])',
          [entityIds],
        );
        await client.query(
          `DELETE FROM geodata_audit_event WHERE aggregate_type='entity'
           AND aggregate_id=ANY($1::text[])`,
          [entityIds],
        );
        await client.query(
          'DELETE FROM geodata_entity WHERE id=ANY($1::uuid[])',
          [entityIds],
        );
      }
      if (runIds.length) {
        const manifests = await client.query(
          'SELECT id::text FROM source_snapshot_manifest WHERE import_run_id=ANY($1::uuid[])',
          [runIds],
        );
        const manifestIds = (manifests.rows as Array<{ id: string }>).map(
          (row) => row.id,
        );
        if (manifestIds.length)
          await client.query(
            'DELETE FROM source_snapshot_record WHERE manifest_id=ANY($1::uuid[])',
            [manifestIds],
          );
        await client.query(
          'DELETE FROM source_snapshot_manifest WHERE import_run_id=ANY($1::uuid[])',
          [runIds],
        );
        await client.query(
          `DELETE FROM idempotency_record
           WHERE response->'source'->>'loadTestRunId'=$1`,
          [testRunId],
        );
        await client.query('DELETE FROM import_run WHERE id=ANY($1::uuid[])', [
          runIds,
        ]);
      }
      if (uploads.length)
        await client.query(
          'DELETE FROM geodata_upload_session WHERE id=ANY($1::uuid[])',
          [uploads.map((upload) => upload.id)],
        );
      if (aggregateIds.length) {
        const fixtureEvents = `SELECT event_id FROM outbox_event
          WHERE aggregate_id=ANY($1::text[])`;
        await client.query(
          `DELETE FROM outbox_redrive_audit
            WHERE event_id IN (${fixtureEvents})`,
          [aggregateIds],
        );
        await client.query(
          `DELETE FROM dead_letter_event
            WHERE event_id IN (${fixtureEvents})`,
          [aggregateIds],
        );
        await client.query(
          'DELETE FROM outbox_event WHERE aggregate_id=ANY($1::text[])',
          [aggregateIds],
        );
      }

      const result = {
        testRunId,
        importsDeleted: runIds.length,
        entitiesDeleted: entityIds.length,
        objectsDeleted: objects.length,
        uploadSessionsDeleted: uploads.length,
        cleaned: true,
      };
      await this.insertCleanupEvent(client, testRunId, result);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private authorizeCleanup(claims: AccessTokenClaims) {
    if (
      !claims.roles?.some((role) =>
        ['GLOBAL_ADMIN', 'GLOBAL_OPERATOR'].includes(String(role.role)),
      )
    )
      throw new ForbiddenException('global administrator access is required');
  }

  private verifyEnvironment() {
    const environment = (process.env.MYOTA_ENV ?? '').toLowerCase();
    if (
      !isLoadTestCleanupEnabled(
        environment,
        process.env.MYOTA_LOAD_TEST_CLEANUP_ENABLED,
      )
    )
      throw new ForbiddenException(
        'load-test cleanup is disabled unless explicitly enabled in a declared environment',
      );
    if (
      environment === 'production' &&
      process.env.MYOTA_LOAD_TEST_ALLOW_PRODUCTION_CLEANUP !== 'YES'
    )
      throw new ForbiddenException(
        'production load-test cleanup requires explicit production cleanup acknowledgement',
      );
  }

  private taggedObjects(
    runs: Array<{ source_metadata: Record<string, unknown> }>,
    uploads: Array<{ bucket: string; object_key: string }>,
  ) {
    const objects = new Map<string, TaggedObject>();
    const add = (bucket: unknown, key: unknown) => {
      if (typeof key !== 'string' || !key) return;
      const objectBucket = typeof bucket === 'string' ? bucket : '';
      objects.set(`${objectBucket}\n${key}`, { bucket: objectBucket, key });
    };
    for (const run of runs) {
      const metadata = run.source_metadata;
      const sourceObject = isRecord(metadata.sourceObject)
        ? metadata.sourceObject
        : {};
      const source = isRecord(metadata.source) ? metadata.source : {};
      add(
        sourceObject.bucket ?? source.bucket,
        sourceObject.key ?? source.objectKey,
      );
    }
    for (const upload of uploads) add(upload.bucket, upload.object_key);
    return [...objects.values()];
  }

  private async assertNoActivityImpact(
    authorization: string,
    entityIds: string[],
  ) {
    const base = (
      process.env.MYOTA_ACTIVITY_URL ?? 'http://activity:8004'
    ).replace(/\/+$/, '');
    for (let start = 0; start < entityIds.length; start += 8) {
      const batch = entityIds.slice(start, start + 8);
      const impacts = await Promise.all(
        batch.map(async (entityId) => {
          const response = await fetch(
            `${base}/v1/activations/entity-deletion-impacts/${encodeURIComponent(entityId)}`,
            {
              headers: { authorization, accept: 'application/json' },
              signal: AbortSignal.timeout(15_000),
            },
          );
          if (response.status === 401 || response.status === 403)
            throw new ForbiddenException(
              'activity.admin scope is required to verify load-test cleanup impact',
            );
          if (!response.ok)
            throw new ServiceUnavailableException(
              `Activity impact check returned HTTP ${response.status}`,
            );
          return (await response.json()) as Record<string, unknown>;
        }),
      );
      if (
        impacts.some((impact) =>
          ['qsoCount', 'activationCount', 'awardProgressCount'].some(
            (field) => Number(impact[field] ?? 0) > 0,
          ),
        )
      )
        throw new BadRequestException(
          'a tagged load-test entity has activity; cleanup stopped to protect QSOs and awards',
        );
    }
  }

  private async insertCleanupEvent(
    client: PoolClient,
    testRunId: string,
    payload: Record<string, unknown>,
  ) {
    await client.query(
      `INSERT INTO outbox_event
       (event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
       VALUES ($1,'geodata.loadtest.cleaned.v1','geodata-service','load_test_run',$2,$3::jsonb,now(),$4)`,
      [
        randomUUID(),
        testRunId,
        stringifyJsonWithBigInts(payload),
        randomUUID(),
      ],
    );
  }

  private storageClient() {
    if (!this.storage)
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
    return this.storage;
  }

  private async connect() {
    if (!this.pool)
      throw new ServiceUnavailableException(
        'Geodata database is not configured',
      );
    try {
      return await this.pool.connect();
    } catch {
      throw new ServiceUnavailableException('Geodata database is unavailable');
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
