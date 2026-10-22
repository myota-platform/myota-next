import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  AckPolicy,
  DeliverPolicy,
  jetstream,
  jetstreamManager,
  ReplayPolicy,
  RetentionPolicy,
  StorageType,
} from '@nats-io/jetstream';
import type { ConsumerConfig, StreamConfig } from '@nats-io/jetstream';
import { connect } from '@nats-io/transport-node';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { stringifyJsonWithBigInts } from '../../../libs/platform/src/json-bigint.js';
import { retryTransientDatabaseOperation } from '../../../libs/platform/src/database-retry.js';
import { startPostgresFaultProxy } from '../../../libs/platform/src/testing/postgres-fault-proxy.js';
import { GeodataRetentionRepository } from './geodata-retention.repository.js';
import { GeodataEnrichmentRepository } from './geodata-enrichment.repository.js';
import { GeodataWorkerService } from './geodata-worker.service.js';
import { GeodataWorkRepository } from './geodata-work.repository.js';

const recoveryTestName =
  'replays committed staging after a worker process is killed';
const brokerRecoveryTestName =
  'resumes all durables after restart and retries after repository failure';
const retentionRecoveryTestName =
  'retries expired import retention after a database outage during source deletion';

describe('Geodata worker process recovery', () => {
  it.skipIf(
    process.env.MYOTA_GEO_WORKER_RECOVERY_TEST !== '1' ||
      !process.env.GEO_DATABASE_URL,
  )(
    recoveryTestName,
    async () => {
      if (process.env.MYOTA_GEO_WORKER_RECOVERY_PHASE) {
        await runRecoveryWorkerPhase();
        return;
      }
      await verifyWorkerRecovery();
    },
    120_000,
  );

  it.skipIf(
    process.env.MYOTA_GEO_WORKER_RECOVERY_TEST !== '1' ||
      !process.env.GEO_DATABASE_URL,
  )(brokerRecoveryTestName, async () => verifyBrokerRecovery(), 45_000);

  it.skipIf(
    process.env.MYOTA_GEO_WORKER_RECOVERY_TEST !== '1' ||
      !process.env.GEO_DATABASE_URL,
  )(retentionRecoveryTestName, async () => verifyRetentionRecovery(), 30_000);
});

async function verifyRetentionRecovery() {
  const databaseUrl = process.env.GEO_DATABASE_URL;
  if (!databaseUrl) throw new Error('GEO_DATABASE_URL is required');
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname)
  )
    throw new Error('retention recovery qualification requires local Postgres');

  const databaseProxy = await startPostgresFaultProxy(databaseUrl);
  const { Pool } = await import('pg');
  const directDatabase = new Pool({ connectionString: databaseUrl, max: 1 });
  const retryDatabase = new Pool({
    connectionString: databaseProxy.connectionString,
    max: 1,
    connectionTimeoutMillis: 500,
  });
  retryDatabase.on('error', () => undefined);
  retryDatabase.on('connect', (client) => {
    client.on('error', () => undefined);
  });

  const runId = randomUUID();
  const importBucket = `retention-${runId}`;
  const savedEnvironment = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries({
    GEODATA_IMPORT_RETENTION_DAYS: '1',
    GEODATA_IMPORT_RETENTION_BATCH_SIZE: '10',
    MYOTA_GEODATA_IMPORT_BUCKET: importBucket,
  })) {
    savedEnvironment.set(name, process.env[name]);
    process.env[name] = value;
  }

  const originalSend = S3Client.prototype.send.bind(S3Client.prototype);
  let sourceDeletions = 0;
  S3Client.prototype.send = (async (command: unknown) => {
    if (command instanceof DeleteObjectCommand) {
      sourceDeletions++;
      if (sourceDeletions === 1) databaseProxy.setAvailable(false);
      return {};
    }
    if (command instanceof AbortMultipartUploadCommand) return {};
    throw new Error('unexpected S3 command in retention recovery fixture');
  }) as typeof S3Client.prototype.send;

  try {
    const fixture = await directDatabase.connect();
    try {
      await fixture.query('BEGIN');
      await fixture.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await fixture.query(
        `INSERT INTO import_run
          (id,adapter_code,source_metadata,status,started_at,completed_at)
         VALUES ($1,'MANUAL',$2::jsonb,'FAILED',now()-interval '2 days',
           now()-interval '2 days')`,
        [
          runId,
          stringifyJsonWithBigInts({
            source: {
              bucket: importBucket,
              objectKey: `retention/${runId}.geojson`,
            },
          }),
        ],
      );
      await fixture.query('COMMIT');
    } catch (error) {
      await fixture.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      fixture.release();
    }

    databaseProxy.setAvailable(false);
    let retryCount = 0;
    const result = await retryTransientDatabaseOperation(
      () => new GeodataRetentionRepository(retryDatabase as Pool).purgeSweep(),
      {
        stopping: () => false,
        onRetry: () => {
          retryCount++;
          databaseProxy.setAvailable(true);
        },
        wait: async () => undefined,
        baseDelayMs: 1,
        maxDelayMs: 1,
      },
    );

    expect(retryCount).toBe(2);
    expect(sourceDeletions).toBe(2);
    expect(result).toMatchObject({ eligible: 1, purged: 1, failed: 0 });
    const remaining = await directDatabase.query(
      'SELECT 1 FROM import_run WHERE id=$1',
      [runId],
    );
    expect(remaining.rowCount).toBe(0);
  } finally {
    databaseProxy.setAvailable(true);
    S3Client.prototype.send = originalSend;
    const cleanup = await directDatabase.connect().catch(() => undefined);
    if (cleanup) {
      try {
        await cleanup.query('BEGIN');
        await cleanup.query(
          "SELECT set_config('myota.geodata_writer','row-v1',true)",
        );
        await cleanup.query('DELETE FROM import_run WHERE id=$1', [runId]);
        await cleanup.query('COMMIT');
      } catch {
        await cleanup.query('ROLLBACK').catch(() => undefined);
      } finally {
        cleanup.release();
      }
    }
    await retryDatabase.end();
    await directDatabase.end();
    await databaseProxy.close();
    for (const [name, value] of savedEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function verifyBrokerRecovery() {
  const databaseUrl = process.env.GEO_DATABASE_URL;
  if (!databaseUrl) throw new Error('GEO_DATABASE_URL is required');
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname)
  )
    throw new Error('broker recovery qualification requires local Postgres');

  const directory = await mkdtemp(join(tmpdir(), 'myota-geodata-worker-'));
  const natsPort = await reserveLocalPort();
  const healthPort = await reserveLocalPort();
  const natsUrl = `nats://127.0.0.1:${natsPort}`;
  const databaseProxy = await startPostgresFaultProxy(databaseUrl);
  const { Pool } = await import('pg');
  const directDatabase = new Pool({ connectionString: databaseUrl, max: 1 });
  const databaseProbe = new Pool({
    connectionString: databaseProxy.connectionString,
    max: 1,
    connectionTimeoutMillis: 500,
  });
  // The fault proxy deliberately destroys idle sockets during injected outages.
  databaseProbe.on('error', () => undefined);
  databaseProbe.on('connect', (client) => {
    client.on('error', () => undefined);
  });
  const savedEnvironment = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries({
    NATS_URL: natsUrl,
    GEO_DATABASE_URL: databaseUrl,
    GEODATA_WORKER_HEALTH_PORT: String(healthPort),
    GEODATA_WORKER_MAX_ACK_PENDING: '1',
    GEODATA_WORKER_ACK_WAIT_SECONDS: '2',
  })) {
    savedEnvironment.set(name, process.env[name]);
    process.env[name] = value;
  }

  const completedJobs = new Set<string>();
  const executionOrder: string[] = [];
  const processedPreprocessing: string[] = [];
  const processedPromotions: string[] = [];
  const processedEnrichments: string[] = [];
  const outageImportRunId = randomUUID();
  const settlementImportRunId = randomUUID();
  const settlementEnrichmentEntityId = randomUUID();
  const settlementEnrichmentRequestId = randomUUID();
  const staleEnrichmentEntityId = randomUUID();
  const staleEnrichmentRequestId = randomUUID();
  const changedGeometryEntityId = randomUUID();
  const changedGeometryRequestId = randomUUID();
  let outageClaimAttempts = 0;
  let outageStateAttempts = 0;
  let enrichmentClaimAttempts = 0;
  let failSettlementOnce = true;
  let failEnrichmentSettlementOnce = true;
  const liveWorkRepository = new GeodataWorkRepository(databaseProbe as Pool);
  const liveEnrichmentRepository = new GeodataEnrichmentRepository(
    databaseProbe as Pool,
  );
  const liveImportRunIds = new Set([outageImportRunId, settlementImportRunId]);
  const workRepository = {
    claim: vi.fn(async (importRunId: string) => {
      if (liveImportRunIds.has(importRunId)) {
        if (importRunId === outageImportRunId) outageClaimAttempts++;
        return liveWorkRepository.claim(importRunId);
      }
      return { importRunId };
    }),
    getRunState: vi.fn(async (importRunId: string) => {
      if (liveImportRunIds.has(importRunId)) {
        if (importRunId === outageImportRunId) outageStateAttempts++;
        return liveWorkRepository.getRunState(importRunId);
      }
      return { status: 'QUEUED', leaseRemainingSeconds: 0 };
    }),
    preprocess: vi.fn(async (run: { importRunId?: string; id?: string }) => {
      const runId = run.importRunId ?? run.id ?? '';
      if (runId === settlementImportRunId && failSettlementOnce) {
        failSettlementOnce = false;
        databaseProxy.setAvailable(false);
        throw new Error('injected failure before retry-state persistence');
      }
      processedPreprocessing.push(runId);
    }),
    fail: vi.fn(async (run: { id: string }, error: unknown) => {
      if (run.id === settlementImportRunId)
        return liveWorkRepository.fail(run as never, error);
      throw new Error('unexpected import failure in recovery fixture');
    }),
    renewHeartbeat: vi.fn(async () => true),
    staleCancellationIds: vi.fn(async () => []),
    recoverExpiredWorkDispatches: vi.fn(async () => ({
      preprocessing: 0,
      promotion: 0,
      deletion: 0,
      enrichment: 0,
    })),
  };
  const promotion = {
    claimPromotion: vi.fn(async (queueId: string) => ({ queueId })),
    processPromotion: vi.fn(async ({ queueId }: { queueId: string }) => {
      processedPromotions.push(queueId);
    }),
  };
  const enrichment = {
    claim: vi.fn(async (entityId: string, requestId: string) => {
      if (entityId === settlementEnrichmentEntityId) {
        enrichmentClaimAttempts++;
        return liveEnrichmentRepository.claim(entityId, requestId);
      }
      return { entityId, requestId };
    }),
    getRequestState: vi.fn(async (entityId: string) => {
      if (entityId === settlementEnrichmentEntityId)
        return liveEnrichmentRepository.getRequestState(entityId);
      return { status: 'QUEUED', requestId: null, leaseRemainingSeconds: 0 };
    }),
    process: vi.fn(async (job: { id: string; requestId: string }) => {
      if (
        job.id === settlementEnrichmentEntityId &&
        failEnrichmentSettlementOnce
      ) {
        failEnrichmentSettlementOnce = false;
        databaseProxy.setAvailable(false);
        throw new Error('injected enrichment failure before settlement');
      }
      processedEnrichments.push(job.requestId);
    }),
  };
  const deletions = {
    claim: vi.fn(async (jobId: string) =>
      completedJobs.has(jobId) ? null : { jobId },
    ),
    getDeletionState: vi.fn(async (jobId: string) => ({
      status: completedJobs.has(jobId) ? 'DELETED' : 'QUEUED',
      leaseRemainingSeconds: 0,
    })),
    execute: vi.fn(async ({ jobId }: { jobId: string }) => {
      completedJobs.add(jobId);
      executionOrder.push(jobId);
      return true;
    }),
  };
  const retention = {
    purgeSweep: vi.fn(async () => ({ eligible: 0, uploadsExpired: 0 })),
  };

  let server: ChildProcess | undefined;
  let publisher: Awaited<ReturnType<typeof connect>> | undefined;
  let worker: GeodataWorkerService | undefined;
  const jobIds = [randomUUID(), randomUUID()];
  const importRunId = randomUUID();
  const queueId = randomUUID();
  const entityId = randomUUID();
  const requestId = randomUUID();
  const enrichmentGeometry = { type: 'Point', coordinates: [7, 46] };
  const enrichmentGeometryHash = createHash('sha256')
    .update(stringifyJsonWithBigInts(enrichmentGeometry))
    .digest('hex');
  const changedGeometry = { type: 'Point', coordinates: [8.1234, 47.5678] };
  let changedGeometryHash = '';
  try {
    const fixture = await directDatabase.connect();
    try {
      await fixture.query('BEGIN');
      await fixture.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      for (const [runId, name] of [
        [outageImportRunId, 'database-claim-outage'],
        [settlementImportRunId, 'database-settlement-outage'],
      ]) {
        await fixture.query(
          `INSERT INTO import_run
            (id,adapter_code,source_metadata,status,source_key,source_hash)
           VALUES ($1,'MANUAL',$2::jsonb,'QUEUED',$3,$4)`,
          [
            runId,
            stringifyJsonWithBigInts({
              source: { name },
              sourceObject: {
                bucket: 'test-bucket',
                key: `test/${runId}.json`,
              },
              filename: `${runId}.geojson`,
              format: 'GEOJSON',
              entityTypes: ['TEST_PARK'],
            }),
            `test/${runId}.json`,
            'a'.repeat(64),
          ],
        );
      }
      await fixture.query(
        `INSERT INTO geodata_entity
          (id,name,lifecycle_status,geom,centroid,public_properties)
         VALUES ($1,'enrichment-settlement-outage','APPROVED',
           ST_SetSRID(ST_MakePoint(7,46),4326),
           ST_SetSRID(ST_MakePoint(7,46),4326)::geography,$2::jsonb)`,
        [
          settlementEnrichmentEntityId,
          stringifyJsonWithBigInts({
            locationEnrichmentRequestId: settlementEnrichmentRequestId,
            locationEnrichmentGeometryHash: enrichmentGeometryHash,
            locationEnrichmentStatus: 'QUEUED',
            locationEnrichmentOnlyMissing: true,
            locationEnrichmentReason: 'recovery-test',
            locationEnrichmentRequestedBy: 'recovery-test',
          }),
        ],
      );
      await fixture.query(
        `INSERT INTO geodata_entity
          (id,name,lifecycle_status,geom,centroid,public_properties)
         VALUES ($1,'stale-enrichment-geometry','APPROVED',
           ST_SetSRID(ST_MakePoint(7,46),4326),
           ST_SetSRID(ST_MakePoint(7,46),4326)::geography,$2::jsonb)`,
        [
          staleEnrichmentEntityId,
          stringifyJsonWithBigInts({
            locationEnrichmentRequestId: staleEnrichmentRequestId,
            locationEnrichmentGeometryHash: enrichmentGeometryHash,
            locationEnrichmentStatus: 'PROCESSING',
            locationEnrichmentOnlyMissing: true,
            locationEnrichmentReason: 'recovery-test',
          }),
        ],
      );
      const changedGeometryResult = await fixture.query<{
        geometry: Record<string, unknown>;
      }>(
        `SELECT ST_AsGeoJSON(
           ST_SetSRID(ST_MakePoint(8.1234,47.5678),4326)
         )::jsonb AS geometry`,
      );
      changedGeometryHash = createHash('sha256')
        .update(
          stringifyJsonWithBigInts(changedGeometryResult.rows[0]!.geometry),
        )
        .digest('hex');
      await fixture.query(
        `INSERT INTO geodata_entity
          (id,name,lifecycle_status,geom,centroid,public_properties)
         VALUES ($1,'changed-enrichment-geometry','APPROVED',
           ST_SetSRID(ST_MakePoint(8.1234,47.5678),4326),
           ST_SetSRID(ST_MakePoint(8.1234,47.5678),4326)::geography,$2::jsonb)`,
        [
          changedGeometryEntityId,
          stringifyJsonWithBigInts({
            locationEnrichmentRequestId: changedGeometryRequestId,
            locationEnrichmentGeometryHash: changedGeometryHash,
            locationEnrichmentStatus: 'PROCESSING',
            locationEnrichmentOnlyMissing: true,
            locationEnrichmentReason: 'recovery-test',
          }),
        ],
      );
      await fixture.query('COMMIT');
    } catch (error) {
      await fixture.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      fixture.release();
    }

    await liveEnrichmentRepository.process({
      id: staleEnrichmentEntityId,
      requestId: staleEnrichmentRequestId,
      geometryHash: '0'.repeat(64),
      onlyMissing: true,
      reason: 'recovery-test',
      requestedBy: 'recovery-test',
      geometry: enrichmentGeometry,
      point: [7, 46],
    });
    const staleState = await directDatabase.query<{ status: string }>(
      "SELECT public_properties->>'locationEnrichmentStatus' AS status FROM geodata_entity WHERE id=$1",
      [staleEnrichmentEntityId],
    );
    expect(staleState.rows[0]?.status).toBe('SUPERSEDED');
    const staleEvent = await directDatabase.query<{ status: string }>(
      `SELECT payload->>'status' AS status FROM outbox_event
       WHERE aggregate_type='entity' AND aggregate_id=$1
         AND event_type='geodata.entity.location-enriched.v1'`,
      [staleEnrichmentEntityId],
    );
    expect(staleEvent.rows).toEqual([{ status: 'SUPERSEDED' }]);

    const previousGeocoderKey = process.env.BIGDATACLOUD_API_KEY;
    const previousGeocoderUrl = process.env.BIGDATACLOUD_REVERSE_GEOCODE_URL;
    process.env.BIGDATACLOUD_API_KEY = 'recovery-test-key';
    process.env.BIGDATACLOUD_REVERSE_GEOCODE_URL =
      'https://geocoder.fixture.test/reverse';
    const providerFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => {
        const update = await directDatabase.connect();
        try {
          await update.query('BEGIN');
          await update.query(
            "SELECT set_config('myota.geodata_writer','row-v1',true)",
          );
          await update.query(
            `UPDATE geodata_entity SET geom=
               ST_SetSRID(ST_MakePoint(8.1235,47.5679),4326)
             WHERE id=$1`,
            [changedGeometryEntityId],
          );
          await update.query('COMMIT');
        } catch (error) {
          await update.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          update.release();
        }
        return new Response('{}', { status: 200 });
      });
    try {
      await liveEnrichmentRepository.process({
        id: changedGeometryEntityId,
        requestId: changedGeometryRequestId,
        geometryHash: changedGeometryHash,
        onlyMissing: true,
        reason: 'recovery-test',
        requestedBy: 'recovery-test',
        geometry: changedGeometry,
        point: [8.1234, 47.5678],
      });
    } finally {
      providerFetch.mockRestore();
      if (previousGeocoderKey === undefined)
        delete process.env.BIGDATACLOUD_API_KEY;
      else process.env.BIGDATACLOUD_API_KEY = previousGeocoderKey;
      if (previousGeocoderUrl === undefined)
        delete process.env.BIGDATACLOUD_REVERSE_GEOCODE_URL;
      else process.env.BIGDATACLOUD_REVERSE_GEOCODE_URL = previousGeocoderUrl;
    }
    const changedGeometryState = await directDatabase.query<{
      status: string;
    }>(
      "SELECT public_properties->>'locationEnrichmentStatus' AS status FROM geodata_entity WHERE id=$1",
      [changedGeometryEntityId],
    );
    expect(changedGeometryState.rows[0]?.status).toBe('SUPERSEDED');
    const changedGeometryEvent = await directDatabase.query<{
      status: string;
    }>(
      `SELECT payload->>'status' AS status FROM outbox_event
       WHERE aggregate_type='entity' AND aggregate_id=$1
         AND event_type='geodata.entity.location-enriched.v1'`,
      [changedGeometryEntityId],
    );
    expect(changedGeometryEvent.rows).toEqual([{ status: 'SUPERSEDED' }]);

    server = await startRecoveryJetStream(natsPort, directory);
    publisher = await connect({
      servers: natsUrl,
      name: 'geodata-worker-restart-publisher',
      maxReconnectAttempts: -1,
      reconnectTimeWait: 100,
    });
    const manager = await jetstreamManager(publisher);
    await manager.streams.add({
      name: 'MYOTA_GEODATA_WORK',
      subjects: ['myota.work.geodata.>'],
      retention: RetentionPolicy.Workqueue,
      storage: StorageType.File,
      num_replicas: 1,
      max_age: 1_209_600_000_000_000,
      max_bytes: 16 * 1024 * 1024,
      max_msgs: 100,
      max_msg_size: 900_000,
    } as StreamConfig);
    const consumers = [
      [
        'geodata-preprocessing-v1',
        'myota.work.geodata.import-preprocess.v1',
        2,
        100,
      ],
      [
        'geodata-import-promotion-v1',
        'myota.work.geodata.import-promotion.v1',
        2,
        100,
      ],
      [
        'geodata-entity-deletion-v1',
        'myota.work.geodata.entity-delete.v1',
        2,
        100,
      ],
      [
        'geodata-location-enrichment-v1',
        'myota.work.geodata.location-enrichment.v1',
        2,
        8,
      ],
    ] as const;
    for (const [
      durable,
      filterSubject,
      ackWaitSeconds,
      maxDeliveries,
    ] of consumers) {
      await manager.consumers.add('MYOTA_GEODATA_WORK', {
        durable_name: durable,
        filter_subject: filterSubject,
        deliver_policy: DeliverPolicy.All,
        ack_policy: AckPolicy.Explicit,
        replay_policy: ReplayPolicy.Instant,
        ack_wait: ackWaitSeconds * 1_000_000_000,
        max_deliver: maxDeliveries,
        max_ack_pending: 1,
        max_waiting: 1,
        num_replicas: 0,
      } as ConsumerConfig);
    }

    worker = new GeodataWorkerService(
      workRepository as never,
      promotion as never,
      enrichment as never,
      deletions as never,
      retention as never,
      null,
    );
    await worker.onModuleInit();
    const workerState = worker as unknown as { natsUp: boolean };
    await waitForRecovery(
      () => workerState.natsUp,
      'Geodata worker did not connect to JetStream',
    );
    await publishDeletion(publisher, jobIds[0]!);
    await waitForRecovery(
      () => completedJobs.has(jobIds[0]!),
      'Geodata worker did not process work before restart',
    );
    await waitForRecovery(async () => {
      const consumer = await manager.consumers.info(
        'MYOTA_GEODATA_WORK',
        'geodata-entity-deletion-v1',
      );
      return consumer.num_pending === 0 && consumer.num_ack_pending === 0;
    }, 'Geodata worker did not settle its first delivery before restart');

    await stopRecoveryJetStream(server);
    server = undefined;
    await waitForRecovery(
      () => !workerState.natsUp,
      'Geodata worker did not detect the JetStream outage',
    );

    server = await startRecoveryJetStream(natsPort, directory);
    await waitForRecovery(
      () => workerState.natsUp,
      'Geodata worker did not reconnect to JetStream',
    );
    const restartedManager = await jetstreamManager(publisher);
    await restartedManager.streams.info('MYOTA_GEODATA_WORK');
    await publishDeletion(publisher, jobIds[1]!);
    await publishGeodataWork(
      publisher,
      'geodata.import-preprocess.v1',
      importRunId,
      { type: 'import_run', id: importRunId },
      { importRunId },
    );
    await publishGeodataWork(
      publisher,
      'geodata.import-promotion.v1',
      queueId,
      { type: 'import_processing_queue', id: queueId },
      { queueId },
    );
    await publishGeodataWork(
      publisher,
      'geodata.location-enrichment.v1',
      requestId,
      { type: 'entity', id: entityId },
      {
        entityId,
        requestId,
        geometryHash: 'a'.repeat(64),
        onlyMissing: true,
        reason: 'restart-recovery',
      },
    );
    await waitForRecovery(
      () =>
        completedJobs.has(jobIds[1]!) &&
        processedPreprocessing.includes(importRunId) &&
        processedPromotions.includes(queueId) &&
        processedEnrichments.includes(requestId),
      'Geodata work durables did not resume delivery after broker restart',
    );

    const rejectedBeforeOutage = databaseProxy.rejectedConnections();
    databaseProxy.setAvailable(false);
    await publishGeodataWork(
      publisher,
      'geodata.import-preprocess.v1',
      outageImportRunId,
      { type: 'import_run', id: outageImportRunId },
      { importRunId: outageImportRunId },
    );
    await waitForRecovery(async () => {
      const consumer = await manager.consumers.info(
        'MYOTA_GEODATA_WORK',
        'geodata-preprocessing-v1',
      );
      return (
        databaseProxy.rejectedConnections() >= rejectedBeforeOutage + 2 &&
        outageClaimAttempts > 0 &&
        outageStateAttempts > 0 &&
        consumer.num_ack_pending > 0
      );
    }, 'Geodata worker did not encounter the PostgreSQL connection outage');
    databaseProxy.setAvailable(true);
    await waitForRecovery(
      () => processedPreprocessing.includes(outageImportRunId),
      'Geodata preprocessing work did not recover after the database returned',
    );
    await waitForRecovery(async () => {
      const consumer = await manager.consumers.info(
        'MYOTA_GEODATA_WORK',
        'geodata-preprocessing-v1',
      );
      return consumer.num_pending === 0 && consumer.num_ack_pending === 0;
    }, 'Geodata worker did not acknowledge the recovered import delivery');
    const claimedRun = await directDatabase.query<{
      status: string;
      attempt_count: number;
    }>('SELECT status,attempt_count FROM import_run WHERE id=$1', [
      outageImportRunId,
    ]);
    expect(claimedRun.rows[0]).toMatchObject({
      status: 'PROCESSING',
      attempt_count: 1,
    });

    const rejectedBeforeSettlement = databaseProxy.rejectedConnections();
    await publishGeodataWork(
      publisher,
      'geodata.import-preprocess.v1',
      settlementImportRunId,
      { type: 'import_run', id: settlementImportRunId },
      { importRunId: settlementImportRunId },
    );
    await waitForRecovery(async () => {
      const consumer = await manager.consumers.info(
        'MYOTA_GEODATA_WORK',
        'geodata-preprocessing-v1',
      );
      return (
        !failSettlementOnce &&
        databaseProxy.rejectedConnections() > rejectedBeforeSettlement &&
        consumer.num_ack_pending > 0
      );
    }, 'Geodata worker did not retain the delivery while retry state was unavailable');
    databaseProxy.setAvailable(true);
    await waitForRecovery(async () => {
      const result = await directDatabase.query<{
        status: string;
        attempt_count: number;
        last_error: string | null;
      }>('SELECT status,attempt_count,last_error FROM import_run WHERE id=$1', [
        settlementImportRunId,
      ]);
      return (
        result.rows[0]?.status === 'QUEUED' &&
        result.rows[0]?.attempt_count === 1 &&
        result.rows[0]?.last_error ===
          'injected failure before retry-state persistence'
      );
    }, 'Geodata worker did not persist the failed import retry after recovery');
    await waitForRecovery(
      () => processedPreprocessing.includes(settlementImportRunId),
      'Geodata worker did not complete the retried import after PostgreSQL recovered',
    );
    await waitForRecovery(async () => {
      const consumer = await manager.consumers.info(
        'MYOTA_GEODATA_WORK',
        'geodata-preprocessing-v1',
      );
      return consumer.num_pending === 0 && consumer.num_ack_pending === 0;
    }, 'Geodata worker did not acknowledge the retried import delivery');
    const retriedRun = await directDatabase.query<{
      status: string;
      attempt_count: number;
    }>('SELECT status,attempt_count FROM import_run WHERE id=$1', [
      settlementImportRunId,
    ]);
    expect(retriedRun.rows[0]).toMatchObject({
      status: 'PROCESSING',
      attempt_count: 2,
    });

    const rejectedBeforeEnrichmentSettlement =
      databaseProxy.rejectedConnections();
    await publishGeodataWork(
      publisher,
      'geodata.location-enrichment.v1',
      settlementEnrichmentRequestId,
      { type: 'entity', id: settlementEnrichmentEntityId },
      {
        entityId: settlementEnrichmentEntityId,
        requestId: settlementEnrichmentRequestId,
        geometryHash: enrichmentGeometryHash,
        onlyMissing: true,
        reason: 'recovery-test',
      },
    );
    await waitForRecovery(async () => {
      const consumer = await manager.consumers.info(
        'MYOTA_GEODATA_WORK',
        'geodata-location-enrichment-v1',
      );
      return (
        !failEnrichmentSettlementOnce &&
        databaseProxy.rejectedConnections() >
          rejectedBeforeEnrichmentSettlement &&
        consumer.num_ack_pending > 0
      );
    }, 'Geodata worker did not retain enrichment delivery while settlement state was unavailable');
    const terminalUpdate = await directDatabase.connect();
    try {
      await terminalUpdate.query('BEGIN');
      await terminalUpdate.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await terminalUpdate.query(
        `UPDATE geodata_entity
         SET public_properties=public_properties || '{"locationEnrichmentStatus":"FAILED"}'::jsonb,
             updated_at=now()
         WHERE id=$1`,
        [settlementEnrichmentEntityId],
      );
      await terminalUpdate.query('COMMIT');
    } catch (error) {
      await terminalUpdate.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      terminalUpdate.release();
    }
    databaseProxy.setAvailable(true);
    await waitForRecovery(async () => {
      const consumer = await manager.consumers.info(
        'MYOTA_GEODATA_WORK',
        'geodata-location-enrichment-v1',
      );
      return consumer.num_pending === 0 && consumer.num_ack_pending === 0;
    }, 'Geodata worker did not acknowledge terminal enrichment work after PostgreSQL recovered');
    expect(enrichmentClaimAttempts).toBe(1);
    expect(processedEnrichments).toEqual([requestId]);

    expect(executionOrder).toEqual(jobIds);
    expect(processedPreprocessing).toEqual([
      importRunId,
      outageImportRunId,
      settlementImportRunId,
    ]);
    expect(processedPromotions).toEqual([queueId]);
    expect(processedEnrichments).toEqual([requestId]);
    expect(outageClaimAttempts).toBeGreaterThanOrEqual(2);
    expect(deletions.execute).toHaveBeenCalledTimes(2);
  } finally {
    if (worker) await worker.onModuleDestroy().catch(() => undefined);
    if (publisher) await publisher.drain().catch(() => undefined);
    if (server) await stopRecoveryJetStream(server).catch(() => undefined);
    databaseProxy.setAvailable(true);
    await databaseProbe.end();
    await databaseProxy.close();
    const cleanup = await directDatabase.connect().catch(() => undefined);
    if (cleanup) {
      try {
        await cleanup.query('BEGIN');
        await cleanup.query(
          "SELECT set_config('myota.geodata_writer','row-v1',true)",
        );
        await cleanup.query(
          `DELETE FROM outbox_event
            WHERE aggregate_type='import_run' AND aggregate_id=ANY($1::text[])`,
          [[outageImportRunId, settlementImportRunId]],
        );
        await cleanup.query(
          'DELETE FROM geodata_import_candidate_stage WHERE import_run_id=ANY($1::uuid[])',
          [[outageImportRunId, settlementImportRunId]],
        );
        await cleanup.query('DELETE FROM import_run WHERE id=ANY($1::uuid[])', [
          [outageImportRunId, settlementImportRunId],
        ]);
        await cleanup.query('DELETE FROM geodata_entity WHERE id=$1', [
          settlementEnrichmentEntityId,
        ]);
        await cleanup.query(
          "DELETE FROM outbox_event WHERE aggregate_type='entity' AND aggregate_id=ANY($1::text[])",
          [[staleEnrichmentEntityId, changedGeometryEntityId]],
        );
        await cleanup.query('DELETE FROM geodata_entity WHERE id=$1', [
          staleEnrichmentEntityId,
        ]);
        await cleanup.query('DELETE FROM geodata_entity WHERE id=$1', [
          changedGeometryEntityId,
        ]);
        await cleanup.query('COMMIT');
      } catch {
        await cleanup.query('ROLLBACK').catch(() => undefined);
      } finally {
        cleanup.release();
      }
    }
    await directDatabase.end();
    for (const [name, value] of savedEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

async function publishDeletion(
  publisher: Awaited<ReturnType<typeof connect>>,
  jobId: string,
) {
  await publishGeodataWork(
    publisher,
    'geodata.entity-delete.v1',
    jobId,
    { type: 'entity_deletion_job', id: jobId },
    { jobId },
  );
}

async function publishGeodataWork(
  publisher: Awaited<ReturnType<typeof connect>>,
  workType: string,
  workId: string,
  aggregate: { type: string; id: string },
  payload: Record<string, unknown>,
) {
  await jetstream(publisher).publish(
    `myota.work.${workType}`,
    new TextEncoder().encode(
      stringifyJsonWithBigInts({
        envelopeVersion: 1,
        workId,
        workType,
        producer: 'geodata',
        createdAt: new Date().toISOString(),
        aggregate,
        payload,
      }),
    ),
  );
}

async function waitForRecovery(
  predicate: () => boolean | Promise<boolean>,
  message: string,
) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function reserveLocalPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  if (!address || typeof address === 'string')
    throw new Error('could not reserve a local recovery test port');
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function startRecoveryJetStream(port: number, storeDirectory: string) {
  const server = spawn(
    'nats-server',
    ['-js', '-p', String(port), '-sd', storeDirectory],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  server.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  server.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null)
      throw new Error(`JetStream exited during startup: ${output}`);
    if (output.includes('Server is ready')) return server;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  server.kill('SIGKILL');
  throw new Error(`JetStream did not start: ${output}`);
}

async function stopRecoveryJetStream(server: ChildProcess) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  server.kill('SIGKILL');
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('JetStream server did not stop')),
      5000,
    );
    server.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function runRecoveryWorkerPhase() {
  const databaseUrl = process.env.GEO_DATABASE_URL;
  const runId = process.env.MYOTA_GEO_WORKER_RECOVERY_RUN_ID;
  const phase = process.env.MYOTA_GEO_WORKER_RECOVERY_PHASE;
  if (!databaseUrl || !runId || !phase)
    throw new Error('worker recovery phase is missing its test settings');

  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const repository = new GeodataWorkRepository(pool as Pool);
  const featureChunks = recoveryFeatureChunks(runId);
  let getObjectCalls = 0;
  const originalSend = S3Client.prototype.send.bind(S3Client.prototype);
  S3Client.prototype.send = (async (command: unknown) => {
    if (!(command instanceof GetObjectCommand))
      throw new Error('unexpected S3 command in worker recovery fixture');
    getObjectCalls++;
    const interruptAfterCheckpoint =
      phase === 'interrupt' && getObjectCalls === 2;
    return {
      Body: Readable.from(
        recoveryBody(featureChunks, interruptAfterCheckpoint),
      ),
    };
  }) as typeof S3Client.prototype.send;

  try {
    const run = await repository.claim(runId);
    if (!run) throw new Error('worker could not claim the recovery fixture');
    await repository.preprocess(run);
  } finally {
    S3Client.prototype.send = originalSend;
    await pool.end();
  }
}

async function verifyWorkerRecovery() {
  const databaseUrl = process.env.GEO_DATABASE_URL;
  if (!databaseUrl) throw new Error('GEO_DATABASE_URL is required');
  const database = new URL(databaseUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(database.hostname))
    throw new Error('worker recovery qualification requires local Postgres');

  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const runId = randomUUID();
  const featureCount = 250;
  const chunks = recoveryFeatureChunks(runId, featureCount);
  const sourceHash = createHash('sha256')
    .update(Buffer.concat(chunks))
    .digest('hex');
  const workerEnvironment = {
    ...process.env,
    GEO_DATABASE_URL: databaseUrl,
    MYOTA_GEO_WORKER_RECOVERY_TEST: '1',
    MYOTA_GEO_WORKER_RECOVERY_RUN_ID: runId,
  };
  let interrupted: ReturnType<typeof spawnRecoveryWorker> | undefined;

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await client.query(
        `INSERT INTO import_run
          (id,adapter_code,source_metadata,status,source_key,source_hash)
         VALUES ($1,'MANUAL',$2::jsonb,'QUEUED',$3,$4)`,
        [
          runId,
          stringifyJsonWithBigInts({
            source: { name: `worker-kill-${runId}` },
            sourceObject: { bucket: 'test-bucket', key: `test/${runId}.json` },
            filename: `${runId}.geojson`,
            format: 'GEOJSON',
            entityTypes: ['TEST_PARK'],
          }),
          `test/${runId}.json`,
          sourceHash,
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    interrupted = spawnRecoveryWorker('interrupt', workerEnvironment);
    await waitForCheckpoint(interrupted, pool, runId);
    interrupted.kill('SIGKILL');
    await waitForExit(interrupted);

    const recoveryClient = await pool.connect();
    try {
      await recoveryClient.query('BEGIN');
      await recoveryClient.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await recoveryClient.query(
        `UPDATE import_run SET lease_until=now()-interval '1 second',
             work_dispatched_at=now()-interval '301 seconds' WHERE id=$1`,
        [runId],
      );
      await recoveryClient.query('COMMIT');
    } catch (error) {
      await recoveryClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      recoveryClient.release();
    }

    const recovered = await new GeodataWorkRepository(
      pool,
    ).recoverExpiredWorkDispatches(300);
    expect(recovered.preprocessing).toBe(1);
    const replay = spawnRecoveryWorker('replay', workerEnvironment);
    const replayResult = await waitForExit(replay, 120_000);
    expect(replayResult.code, replayResult.output).toBe(0);

    const result = await pool.query(
      `SELECT run.status,run.attempt_count,count(candidate.ordinal)::int AS count,
           count(DISTINCT candidate.ordinal)::int AS distinct_ordinals
         FROM import_run run LEFT JOIN geodata_import_candidate candidate
           ON candidate.import_run_id=run.id WHERE run.id=$1
         GROUP BY run.id`,
      [runId],
    );
    expect(result.rows[0]).toMatchObject({
      status: 'PREPROCESSED',
      attempt_count: 2,
      count: featureCount,
      distinct_ordinals: featureCount,
    });
  } finally {
    if (interrupted && interrupted.exitCode === null) {
      interrupted.kill('SIGKILL');
      await waitForExit(interrupted).catch(() => undefined);
    }
    await cleanupRecoveryFixture(pool, runId);
  }
}

async function cleanupRecoveryFixture(pool: Pool, runId: string) {
  const cleanup = await pool.connect();
  let cleanupError: unknown;
  try {
    await cleanup.query('BEGIN');
    await cleanup.query(
      "SELECT set_config('myota.geodata_writer','row-v1',true)",
    );
    await cleanup.query(
      `DELETE FROM source_snapshot_record WHERE manifest_id IN
             (SELECT id FROM source_snapshot_manifest WHERE import_run_id=$1)`,
      [runId],
    );
    await cleanup.query(
      'DELETE FROM source_snapshot_manifest WHERE import_run_id=$1',
      [runId],
    );
    await cleanup.query('DELETE FROM outbox_event WHERE aggregate_id=$1', [
      runId,
    ]);
    await cleanup.query('DELETE FROM import_run WHERE id=$1', [runId]);
    await cleanup.query('COMMIT');
  } catch (error) {
    await cleanup.query('ROLLBACK').catch(() => undefined);
    cleanupError = error;
  } finally {
    cleanup.release();
  }
  await pool.end();
  if (cleanupError) throw cleanupError;
}

function recoveryFeatureChunks(runId: string, count = 250): Buffer[] {
  const chunks = [
    Buffer.from('{"type":"FeatureCollection","features":[', 'utf8'),
  ];
  for (let ordinal = 0; ordinal < count; ordinal++) {
    if (ordinal) chunks.push(Buffer.from(',', 'utf8'));
    chunks.push(
      Buffer.from(
        stringifyJsonWithBigInts({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-5.99, 37.39] },
          properties: {
            name: `worker fixture ${ordinal}`,
            sourceRef: `${runId}-${ordinal}`,
          },
        }),
        'utf8',
      ),
    );
  }
  chunks.push(Buffer.from(']}', 'utf8'));
  return chunks;
}

async function* recoveryBody(
  chunks: Buffer[],
  pauseAfterCheckpoint: boolean,
): AsyncGenerator<Buffer> {
  for (let index = 0; index < chunks.length; index++) {
    yield chunks[index]!;
    if (pauseAfterCheckpoint && index === 200) {
      await new Promise<void>(() => undefined);
    }
  }
}

function spawnRecoveryWorker(
  phase: 'interrupt' | 'replay',
  environment: NodeJS.ProcessEnv,
) {
  const child = spawn(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      'apps/geodata-worker/src/geodata-worker-recovery.spec.ts',
      '-t',
      recoveryTestName,
      '--maxWorkers=1',
      '--no-file-parallelism',
    ],
    {
      env: { ...environment, MYOTA_GEO_WORKER_RECOVERY_PHASE: phase },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  return Object.assign(child, { getOutput: () => output });
}

async function waitForCheckpoint(
  child: ReturnType<typeof spawnRecoveryWorker>,
  pool: Pool,
  runId: string,
) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`worker exited before checkpoint: ${child.getOutput()}`);
    const result = await pool.query(
      'SELECT count(*)::int AS count FROM geodata_import_candidate_stage WHERE import_run_id=$1',
      [runId],
    );
    if (result.rows[0]?.count === 100) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `worker did not stage its first 100 features: ${child.getOutput()}`,
  );
}

async function waitForExit(
  child: ReturnType<typeof spawnRecoveryWorker>,
  timeoutMilliseconds = 15_000,
): Promise<{ code: number | null; output: string }> {
  if (child.exitCode !== null || child.signalCode !== null)
    return { code: child.exitCode, output: child.getOutput() };
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`worker did not exit: ${child.getOutput()}`));
    }, timeoutMilliseconds);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve({ code, output: child.getOutput() });
    });
  });
}
