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
import { DatabaseHealthService } from '../../../libs/platform/src/database.module.js';
import { stringifyJsonWithBigInts } from '../../../libs/platform/src/json-bigint.js';
import { retryTransientDatabaseOperation } from '../../../libs/platform/src/database-retry.js';
import { startPostgresFaultProxy } from '../../../libs/platform/src/testing/postgres-fault-proxy.js';
import {
  startPostgresServiceContainer,
  stopPostgresServiceContainer,
} from '../../../libs/platform/src/testing/postgres-service-container.js';
import {
  addTestStreamWithPlacementRetry,
  startTestJetStreamCluster,
} from '../../../libs/platform/src/testing/jetstream-cluster.js';
import { GeodataRetentionRepository } from './geodata-retention.repository.js';
import { GeodataEnrichmentRepository } from './geodata-enrichment.repository.js';
import { GeodataPromotionRepository } from './geodata-promotion.repository.js';
import { GeodataPromotionScoring } from './geodata-promotion-scoring.js';
import { GeodataDeletionRepository } from './geodata-deletion.repository.js';
import { GeodataWorkerService } from './geodata-worker.service.js';
import { GeodataWorkRepository } from './geodata-work.repository.js';
import { geodataConsumerPolicy } from '../../../libs/platform/src/geodata-consumer-policy.js';
import { GeodataEntityEnrichmentRequestRepository } from '../../geodata/src/geodata-entity-enrichment.repository.js';
import { GeodataEntityMutationSupport } from '../../geodata/src/geodata-entity-mutation-support.js';
import type { AccessTokenClaims } from '../../../libs/platform/src/access-token.js';

const recoveryTestName =
  'replays committed staging after a worker process is killed';
const brokerRecoveryTestName =
  'resumes all durables after restart and retries after repository failure';
const retentionRecoveryTestName =
  'retries expired import retention after a database outage during source deletion';
const clusterFailoverTestName =
  'resumes every durable after JetStream leader failover';
const terminalDeadLetterRecoveryTestName =
  'settles a terminal dead letter after process loss before termination';
const objectStoreRecoveryTestName =
  'retries import preprocessing after a temporary object-store outage';
const processLossBeforeAckTestName =
  'settles committed import preprocessing after worker loss before acknowledgement';
const otherWorkKindProcessLossTestName =
  'settles committed promotion, deletion, and enrichment after worker loss before acknowledgement';
const claimProcessLossTestName =
  'recovers every Geodata work kind after process loss immediately after claim';

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
  )(brokerRecoveryTestName, async () => verifyBrokerRecovery(), 90_000);

  it.skipIf(
    process.env.MYOTA_GEO_WORKER_RECOVERY_TEST !== '1' ||
      !process.env.GEO_DATABASE_URL,
  )(retentionRecoveryTestName, async () => verifyRetentionRecovery(), 30_000);

  it.skipIf(
    process.env.MYOTA_GEO_WORKER_RECOVERY_TEST !== '1' ||
      !process.env.GEO_DATABASE_URL,
  )(clusterFailoverTestName, async () => verifyClusterFailover(), 60_000);

  it.skipIf(
    process.env.MYOTA_GEO_WORKER_RECOVERY_TEST !== '1' ||
      !process.env.GEO_DATABASE_URL,
  )(
    terminalDeadLetterRecoveryTestName,
    async () => {
      if (process.env.MYOTA_GEO_WORKER_DEAD_LETTER_PHASE) {
        await runTerminalDeadLetterWorkerPhase();
        return;
      }
      await verifyTerminalDeadLetterRecovery();
    },
    90_000,
  );

  it.skipIf(
    process.env.MYOTA_GEO_WORKER_RECOVERY_TEST !== '1' ||
      !process.env.GEO_DATABASE_URL,
  )(
    objectStoreRecoveryTestName,
    async () => verifyImportObjectStoreRecovery(),
    90_000,
  );

  it.skipIf(
    process.env.MYOTA_GEO_WORKER_RECOVERY_TEST !== '1' ||
      !process.env.GEO_DATABASE_URL,
  )(
    processLossBeforeAckTestName,
    async () => {
      if (process.env.MYOTA_GEO_WORKER_PROCESS_LOSS_PHASE) {
        await runProcessLossBeforeAckWorkerPhase();
        return;
      }
      await verifyProcessLossBeforeAckRecovery();
    },
    90_000,
  );

  it.skipIf(
    process.env.MYOTA_GEO_WORKER_RECOVERY_TEST !== '1' ||
      !process.env.GEO_DATABASE_URL,
  )(
    otherWorkKindProcessLossTestName,
    async () => {
      if (process.env.MYOTA_GEO_WORKER_OTHER_PROCESS_LOSS_PHASE) {
        await runOtherWorkKindProcessLossWorkerPhase();
        return;
      }
      await verifyOtherWorkKindProcessLossRecovery();
    },
    120_000,
  );

  it.skipIf(
    process.env.MYOTA_GEO_WORKER_RECOVERY_TEST !== '1' ||
      !process.env.GEO_DATABASE_URL,
  )(
    claimProcessLossTestName,
    async () => {
      if (process.env.MYOTA_GEO_WORKER_CLAIM_LOSS_PHASE) {
        await runClaimLossWorkerPhase();
        return;
      }
      await verifyClaimProcessLossRecovery();
    },
    300_000,
  );
});

async function verifyProcessLossBeforeAckRecovery() {
  const databaseUrl = process.env.GEO_DATABASE_URL;
  if (!databaseUrl) throw new Error('GEO_DATABASE_URL is required');
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname)
  )
    throw new Error('worker process-loss recovery requires local Postgres');

  const directory = await mkdtemp(join(tmpdir(), 'myota-geodata-before-ack-'));
  const natsPort = await reserveLocalPort();
  const natsUrl = `nats://127.0.0.1:${natsPort}`;
  const runId = randomUUID();
  const source = Buffer.concat(recoveryFeatureChunks(runId, 2));
  const sourceHash = createHash('sha256').update(source).digest('hex');
  const savedEnvironment = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries({
    NATS_URL: natsUrl,
    GEO_DATABASE_URL: databaseUrl,
    GEODATA_WORKER_HEALTH_PORT: String(await reserveLocalPort()),
    GEODATA_WORKER_MAX_ACK_PENDING: '1',
    GEODATA_WORKER_ACK_WAIT_SECONDS: '2',
    GEODATA_WORKER_MAX_DELIVERIES: '10',
    MYOTA_GEO_WORKER_RECOVERY_RUN_ID: runId,
  })) {
    savedEnvironment.set(name, process.env[name]);
    process.env[name] = value;
  }

  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  let server: ChildProcess | undefined;
  let publisher: Awaited<ReturnType<typeof connect>> | undefined;
  let interrupted:
    ReturnType<typeof spawnProcessLossBeforeAckWorker> | undefined;

  try {
    server = await startRecoveryJetStream(natsPort, directory);
    publisher = await connect({
      servers: natsUrl,
      name: 'geodata-before-ack-recovery-publisher',
    });
    const manager = await jetstreamManager(publisher);
    await manager.streams.add({
      name: 'MYOTA_GEODATA_WORK',
      subjects: ['myota.work.geodata.>'],
      retention: RetentionPolicy.Workqueue,
      storage: StorageType.File,
      num_replicas: 1,
      max_age: 86_400_000_000_000,
      max_bytes: 16 * 1024 * 1024,
      max_msgs: 100,
      max_msg_size: 900_000,
    } as StreamConfig);
    for (const [durable, subject] of [
      ['geodata-preprocessing-v1', 'myota.work.geodata.import-preprocess.v1'],
      ['geodata-import-promotion-v1', 'myota.work.geodata.import-promotion.v1'],
      ['geodata-entity-deletion-v1', 'myota.work.geodata.entity-delete.v1'],
      [
        'geodata-location-enrichment-v1',
        'myota.work.geodata.location-enrichment.v1',
      ],
    ] as const) {
      const policy = geodataConsumerPolicy(durable);
      await manager.consumers.add('MYOTA_GEODATA_WORK', {
        durable_name: durable,
        filter_subject: subject,
        deliver_policy: DeliverPolicy.All,
        ack_policy: AckPolicy.Explicit,
        replay_policy: ReplayPolicy.Instant,
        ack_wait: policy.ackWaitSeconds * 1_000_000_000,
        max_deliver: policy.maxDeliveries,
        max_ack_pending: policy.maxPending,
        max_waiting: 1,
        num_replicas: 0,
      } as ConsumerConfig);
    }

    const fixture = await pool.connect();
    try {
      await fixture.query('BEGIN');
      await fixture.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await fixture.query(
        `INSERT INTO import_run
          (id,adapter_code,source_metadata,status,source_key,source_hash)
         VALUES ($1,'MANUAL',$2::jsonb,$3,$4,$5)`,
        [
          runId,
          stringifyJsonWithBigInts({
            source: { name: 'worker loss before acknowledgement' },
            sourceObject: { bucket: 'recovery-test', key: `${runId}.geojson` },
            filename: `${runId}.geojson`,
            format: 'GEOJSON',
            entityTypes: ['TEST_PARK'],
          }),
          'QUEUED',
          `recovery/${runId}.geojson`,
          sourceHash,
        ],
      );
      await fixture.query('COMMIT');
    } catch (error) {
      await fixture.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      fixture.release();
    }

    await publishGeodataWork(
      publisher,
      'geodata.import-preprocess.v1',
      runId,
      { type: 'import_run', id: runId },
      { importRunId: runId },
    );
    const workerEnvironment = {
      ...process.env,
      MYOTA_GEO_WORKER_RECOVERY_TEST: '1',
      MYOTA_GEO_WORKER_PROCESS_LOSS_PHASE: 'interrupt',
    };
    interrupted = spawnProcessLossBeforeAckWorker(workerEnvironment);
    await waitForOutput(interrupted, 'IMPORT_COMMITTED_BEFORE_ACK', 45_000);
    const committed = await pool.query<{
      status: string;
      attempt_count: number;
      candidates: number;
      distinct_ordinals: number;
    }>(
      `SELECT run.status,run.attempt_count,
              count(candidate.ordinal)::int AS candidates,
              count(DISTINCT candidate.ordinal)::int AS distinct_ordinals
         FROM import_run run LEFT JOIN geodata_import_candidate candidate
           ON candidate.import_run_id=run.id
        WHERE run.id=$1 GROUP BY run.id`,
      [runId],
    );
    expect(committed.rows[0]).toMatchObject({
      status: 'PREPROCESSED',
      attempt_count: 1,
      candidates: 2,
      distinct_ordinals: 2,
    });
    killWorkerProcessTree(interrupted);
    await waitForExit(interrupted);

    const pending = await manager.consumers.info(
      'MYOTA_GEODATA_WORK',
      'geodata-preprocessing-v1',
    );
    expect(pending.num_ack_pending).toBe(1);
    const replayEnvironment = {
      ...process.env,
      MYOTA_GEO_WORKER_RECOVERY_TEST: '1',
      MYOTA_GEO_WORKER_PROCESS_LOSS_PHASE: 'settle',
    };
    const replay = spawnProcessLossBeforeAckWorker(replayEnvironment);
    const replayResult = await waitForExit(replay, 45_000);
    expect(replayResult.code, replayResult.output).toBe(0);

    const finalState = await pool.query<{
      status: string;
      attempt_count: number;
      candidates: number;
      distinct_ordinals: number;
    }>(
      `SELECT run.status,run.attempt_count,
              count(candidate.ordinal)::int AS candidates,
              count(DISTINCT candidate.ordinal)::int AS distinct_ordinals
         FROM import_run run LEFT JOIN geodata_import_candidate candidate
           ON candidate.import_run_id=run.id
        WHERE run.id=$1 GROUP BY run.id`,
      [runId],
    );
    expect(finalState.rows[0]).toMatchObject({
      status: 'PREPROCESSED',
      attempt_count: 1,
      candidates: 2,
      distinct_ordinals: 2,
    });
    const settled = await manager.consumers.info(
      'MYOTA_GEODATA_WORK',
      'geodata-preprocessing-v1',
    );
    expect(settled.num_pending).toBe(0);
    expect(settled.num_ack_pending).toBe(0);
    expect(settled.delivered?.consumer_seq).toBeGreaterThanOrEqual(2);
  } finally {
    if (interrupted && interrupted.exitCode === null) {
      killWorkerProcessTree(interrupted);
      await waitForExit(interrupted).catch(() => undefined);
    }
    await publisher?.drain().catch(() => undefined);
    if (server) await stopRecoveryJetStream(server).catch(() => undefined);
    await cleanupRecoveryFixture(pool, runId);
    await rm(directory, { recursive: true, force: true });
    for (const [name, value] of savedEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function runProcessLossBeforeAckWorkerPhase() {
  const databaseUrl = process.env.GEO_DATABASE_URL;
  const natsUrl = process.env.NATS_URL;
  const runId = process.env.MYOTA_GEO_WORKER_RECOVERY_RUN_ID;
  const phase = process.env.MYOTA_GEO_WORKER_PROCESS_LOSS_PHASE;
  if (!databaseUrl || !natsUrl || !runId || !phase)
    throw new Error('Geodata before-ACK worker phase settings are required');

  const source = Buffer.concat(recoveryFeatureChunks(runId, 2));
  const originalSend = Object.getOwnPropertyDescriptor(
    S3Client.prototype,
    'send',
  )?.value as typeof S3Client.prototype.send;
  S3Client.prototype.send = (async (command: unknown) => {
    if (!(command instanceof GetObjectCommand))
      throw new Error('unexpected S3 command in before-ACK recovery fixture');
    return { Body: Readable.from([source]) };
  }) as typeof S3Client.prototype.send;

  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const worker = new GeodataWorkerService(
    new GeodataWorkRepository(pool),
    new GeodataPromotionRepository(pool, new GeodataPromotionScoring()),
    new GeodataEnrichmentRepository(pool),
    new GeodataDeletionRepository(pool),
    new GeodataRetentionRepository(pool),
    pool,
  );
  const internalWorker = worker as unknown as {
    process(workType: string, job: unknown, message: unknown): Promise<void>;
  };
  const processWork = internalWorker.process.bind(worker);
  internalWorker.process = async (workType, job, message) => {
    await processWork(workType, job, message);
    if (phase === 'interrupt' && workType === 'geodata.import-preprocess.v1') {
      process.stdout.write('IMPORT_COMMITTED_BEFORE_ACK\n');
      await new Promise<void>(() => undefined);
    }
  };

  let monitor: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await worker.onModuleInit();
    if (phase === 'interrupt') await new Promise<void>(() => undefined);
    monitor = await connect({
      servers: natsUrl,
      name: 'geodata-before-ack-monitor',
    });
    const manager = await jetstreamManager(monitor);
    await waitForRecovery(async () => {
      const info = await manager.consumers.info(
        'MYOTA_GEODATA_WORK',
        'geodata-preprocessing-v1',
      );
      return (
        info.delivered?.consumer_seq >= 2 &&
        info.num_pending === 0 &&
        info.num_ack_pending === 0
      );
    }, 'Geodata replay did not settle the completed import delivery');
  } finally {
    await worker.onModuleDestroy().catch(() => undefined);
    await monitor?.drain().catch(() => undefined);
    await pool.end();
    S3Client.prototype.send = originalSend;
  }
}

async function verifyOtherWorkKindProcessLossRecovery() {
  const databaseUrl = process.env.GEO_DATABASE_URL;
  if (!databaseUrl) throw new Error('GEO_DATABASE_URL is required');
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname)
  )
    throw new Error('Geodata process-loss recovery requires local Postgres');

  const directory = await mkdtemp(join(tmpdir(), 'myota-geodata-work-kinds-'));
  const natsPort = await reserveLocalPort();
  const healthPort = await reserveLocalPort();
  const natsUrl = `nats://127.0.0.1:${natsPort}`;
  const promotionRunId = randomUUID();
  const promotionQueueId = randomUUID();
  const promotionCandidateId = randomUUID();
  const promotedEntityId = randomUUID();
  const promotionEntityTypeCode = `WORKER_LOSS_${promotionCandidateId
    .replaceAll('-', '')
    .slice(0, 8)
    .toUpperCase()}`;
  const deletionJobId = randomUUID();
  const deletionEntityId = randomUUID();
  const enrichmentEntityId = randomUUID();
  const enrichmentRequestId = randomUUID();
  const geometry = { type: 'Point', coordinates: [7, 46] };
  const geometryHash = createHash('sha256')
    .update(stringifyJsonWithBigInts(geometry))
    .digest('hex');
  const savedEnvironment = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries({
    NATS_URL: natsUrl,
    GEO_DATABASE_URL: databaseUrl,
    GEODATA_WORKER_HEALTH_PORT: String(healthPort),
    GEODATA_WORKER_MAX_ACK_PENDING: '1',
    GEODATA_WORKER_ACK_WAIT_SECONDS: '2',
    GEODATA_WORKER_MAX_DELIVERIES: '10',
    MYOTA_ACTIVITY_URL: 'http://activity.fixture.test',
    BIGDATACLOUD_API_KEY: 'recovery-test-key',
    BIGDATACLOUD_REVERSE_GEOCODE_URL: 'https://geocoder.fixture.test/reverse',
  })) {
    savedEnvironment.set(name, process.env[name]);
    process.env[name] = value;
  }

  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  let server: ChildProcess | undefined;
  let publisher: Awaited<ReturnType<typeof connect>> | undefined;
  let interrupted:
    ReturnType<typeof spawnProcessLossBeforeAckWorker> | undefined;
  let cleanupError: unknown;

  try {
    server = await startRecoveryJetStream(natsPort, directory);
    publisher = await connect({
      servers: natsUrl,
      name: 'geodata-work-kind-before-ack-publisher',
    });
    const manager = await jetstreamManager(publisher);
    await manager.streams.add({
      name: 'MYOTA_GEODATA_WORK',
      subjects: ['myota.work.geodata.>'],
      retention: RetentionPolicy.Workqueue,
      storage: StorageType.File,
      num_replicas: 1,
      max_age: 86_400_000_000_000,
      max_bytes: 16 * 1024 * 1024,
      max_msgs: 100,
      max_msg_size: 900_000,
    } as StreamConfig);
    const durables = [
      ['geodata-preprocessing-v1', 'myota.work.geodata.import-preprocess.v1'],
      ['geodata-import-promotion-v1', 'myota.work.geodata.import-promotion.v1'],
      ['geodata-entity-deletion-v1', 'myota.work.geodata.entity-delete.v1'],
      [
        'geodata-location-enrichment-v1',
        'myota.work.geodata.location-enrichment.v1',
      ],
    ] as const;
    for (const [durable, subject] of durables) {
      const policy = geodataConsumerPolicy(durable);
      await manager.consumers.add('MYOTA_GEODATA_WORK', {
        durable_name: durable,
        filter_subject: subject,
        deliver_policy: DeliverPolicy.All,
        ack_policy: AckPolicy.Explicit,
        replay_policy: ReplayPolicy.Instant,
        ack_wait: policy.ackWaitSeconds * 1_000_000_000,
        max_deliver: policy.maxDeliveries,
        max_ack_pending: policy.maxPending,
        max_waiting: 1,
        num_replicas: 0,
      } as ConsumerConfig);
    }

    const fixture = await pool.connect();
    try {
      await fixture.query('BEGIN');
      await fixture.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await fixture.query(
        `INSERT INTO import_run
          (id,adapter_code,source_metadata,status,source_key,source_hash)
         VALUES ($1,'MANUAL',$2::jsonb,'PREPROCESSED',$3,$4)`,
        [
          promotionRunId,
          stringifyJsonWithBigInts({
            source: { name: `worker-loss-${promotionRunId}` },
          }),
          `worker-loss/${promotionRunId}`,
          'a'.repeat(64),
        ],
      );
      await fixture.query(
        `INSERT INTO geodata_import_processing_queue
          (id,import_run_id,candidate_ids,target_status,requested_by)
         VALUES ($1,$2,$3::jsonb,'CANDIDATE','recovery-test')`,
        [
          promotionQueueId,
          promotionRunId,
          stringifyJsonWithBigInts([promotionCandidateId]),
        ],
      );
      await fixture.query(
        `INSERT INTO geodata_import_candidate
          (id,import_run_id,ordinal,planned_entity_id,entity_type_codes,name,geom,
           candidate_source,source_ref,source_hash,entity_payload,validation_status,
           target_status,validated_by,validated_at,processing_queue_id)
         VALUES ($1,$2,1,$3,$4::jsonb,'Worker loss promotion candidate',
           ST_SetSRID(ST_GeomFromGeoJSON($5),4326),$6::jsonb,$7,$8,$9::jsonb,
           'CONFIRMED','CANDIDATE','recovery-test',now(),$10)`,
        [
          promotionCandidateId,
          promotionRunId,
          promotedEntityId,
          stringifyJsonWithBigInts([promotionEntityTypeCode]),
          stringifyJsonWithBigInts(geometry),
          stringifyJsonWithBigInts({ name: 'worker loss fixture' }),
          `worker-loss-${promotionCandidateId}`,
          'd'.repeat(64),
          stringifyJsonWithBigInts({
            geometry,
            candidateSource: { name: 'worker loss fixture' },
          }),
          promotionQueueId,
        ],
      );
      await fixture.query(
        `INSERT INTO geodata_entity
          (id,name,lifecycle_status,geom,centroid,public_properties)
         VALUES ($1,'worker-loss-deletion-target','CANDIDATE',
           ST_SetSRID(ST_MakePoint(7,46),4326),
           ST_SetSRID(ST_MakePoint(7,46),4326)::geography,'{}'::jsonb)`,
        [deletionEntityId],
      );
      await fixture.query(
        `INSERT INTO geodata_control_record(kind,id,payload,updated_at)
         VALUES ('entityDeletionJobs',$1,$2::jsonb,now())`,
        [
          deletionJobId,
          stringifyJsonWithBigInts({
            id: deletionJobId,
            entityId: deletionEntityId,
            requestedBy: 'recovery-test',
            status: 'QUEUED',
            leaseUntil: null,
            executionClaims: {
              sub: 'recovery-test',
              scp: [],
              roles: [{ role: 'GLOBAL_OPERATOR' }],
            },
          }),
        ],
      );
      await fixture.query(
        `INSERT INTO geodata_entity
          (id,name,lifecycle_status,geom,centroid,public_properties)
         VALUES ($1,'worker-loss-enrichment','APPROVED',
           ST_SetSRID(ST_MakePoint(7,46),4326),
           ST_SetSRID(ST_MakePoint(7,46),4326)::geography,$2::jsonb)`,
        [
          enrichmentEntityId,
          stringifyJsonWithBigInts({
            locationEnrichmentRequestId: enrichmentRequestId,
            locationEnrichmentGeometryHash: geometryHash,
            locationEnrichmentStatus: 'QUEUED',
            locationEnrichmentOnlyMissing: true,
            locationEnrichmentReason: 'worker-loss-recovery',
            locationEnrichmentRequestedBy: 'recovery-test',
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

    const scenarios = [
      {
        workType: 'geodata.import-promotion.v1',
        durable: 'geodata-import-promotion-v1',
        workId: promotionQueueId,
        aggregate: { type: 'import_processing_queue', id: promotionQueueId },
        payload: { queueId: promotionQueueId },
        assertCommitted: async () => {
          const result = await pool.query<{
            status: string;
            attempt_count: number;
            facts: number;
            candidate_status: string;
            entity_id: string;
            entity_status: string;
            source_references: number;
          }>(
            `SELECT queue.status,queue.attempt_count,
                candidate.validation_status AS candidate_status,
                candidate.processed_entity_id::text AS entity_id,
                entity.lifecycle_status AS entity_status,
                (SELECT count(*)::int FROM source_reference
                 WHERE entity_id=entity.id) AS source_references,
                (SELECT count(*)::int FROM outbox_event
                 WHERE event_type='geodata.import.processing.completed.v1'
                   AND aggregate_id=queue.id::text) AS facts
             FROM geodata_import_processing_queue queue
             JOIN geodata_import_candidate candidate ON candidate.id=$2
             LEFT JOIN geodata_entity entity ON entity.id=$3
             WHERE queue.id=$1`,
            [promotionQueueId, promotionCandidateId, promotedEntityId],
          );
          expect(result.rows[0]).toMatchObject({
            status: 'COMPLETED',
            attempt_count: 1,
            facts: 1,
            candidate_status: 'PROCESSED',
            entity_id: promotedEntityId,
            entity_status: 'CANDIDATE',
            source_references: 1,
          });
        },
      },
      {
        workType: 'geodata.entity-delete.v1',
        durable: 'geodata-entity-deletion-v1',
        workId: deletionJobId,
        aggregate: { type: 'entity_deletion_job', id: deletionJobId },
        payload: { jobId: deletionJobId },
        assertCommitted: async () => {
          const job = await pool.query<{ status: string }>(
            `SELECT payload->>'status' AS status FROM geodata_control_record
             WHERE kind='entityDeletionJobs' AND id=$1`,
            [deletionJobId],
          );
          const effects = await pool.query<{
            events: number;
            audit: number;
            remaining_entities: number;
          }>(
            `SELECT
               (SELECT count(*)::int FROM outbox_event
                WHERE event_type IN ('geodata.entity.deleted.v1',
                  'geodata.entity-deletion-job.completed.v1')
                  AND aggregate_id IN ($1,$2)) AS events,
               (SELECT count(*)::int FROM geodata_audit_event
                WHERE aggregate_id=$1) AS audit,
               (SELECT count(*)::int FROM geodata_entity WHERE id=$3) AS remaining_entities`,
            [deletionEntityId, deletionJobId, deletionEntityId],
          );
          expect(job.rows[0]?.status).toBe('COMPLETED');
          expect(effects.rows[0]).toEqual({
            events: 2,
            audit: 1,
            remaining_entities: 0,
          });
        },
      },
      {
        workType: 'geodata.location-enrichment.v1',
        durable: 'geodata-location-enrichment-v1',
        workId: enrichmentRequestId,
        aggregate: { type: 'entity', id: enrichmentEntityId },
        payload: {
          entityId: enrichmentEntityId,
          requestId: enrichmentRequestId,
          geometryHash,
          onlyMissing: true,
          reason: 'worker-loss-recovery',
        },
        assertCommitted: async () => {
          const result = await pool.query<{
            status: string;
            events: number;
          }>(
            `SELECT entity.public_properties->>'locationEnrichmentStatus' AS status,
                (SELECT count(*)::int FROM outbox_event
                 WHERE event_type='geodata.entity.location-enriched.v1'
                   AND aggregate_id=entity.id::text) AS events
             FROM geodata_entity entity WHERE entity.id=$1`,
            [enrichmentEntityId],
          );
          expect(result.rows[0]).toEqual({ status: 'COMPLETED', events: 1 });
        },
      },
    ] as const;

    for (const scenario of scenarios) {
      await publishGeodataWork(
        publisher,
        scenario.workType,
        scenario.workId,
        scenario.aggregate,
        scenario.payload,
      );
      const workerEnvironment = {
        ...process.env,
        MYOTA_GEO_WORKER_RECOVERY_TEST: '1',
        MYOTA_GEO_WORKER_OTHER_PROCESS_LOSS_PHASE: 'interrupt',
        MYOTA_GEO_WORKER_OTHER_PROCESS_LOSS_KIND: scenario.workType,
      };
      interrupted = spawnProcessLossBeforeAckWorker(
        workerEnvironment,
        otherWorkKindProcessLossTestName,
      );
      await waitForOutput(
        interrupted,
        `COMMITTED_BEFORE_ACK:${scenario.workType}`,
        45_000,
      );
      await scenario.assertCommitted();
      killWorkerProcessTree(interrupted);
      await waitForExit(interrupted);
      interrupted = undefined;

      const pending = await manager.consumers.info(
        'MYOTA_GEODATA_WORK',
        scenario.durable,
      );
      expect(pending.num_ack_pending).toBe(1);
      const replay = spawnProcessLossBeforeAckWorker(
        {
          ...process.env,
          MYOTA_GEO_WORKER_RECOVERY_TEST: '1',
          MYOTA_GEO_WORKER_OTHER_PROCESS_LOSS_PHASE: 'settle',
          MYOTA_GEO_WORKER_OTHER_PROCESS_LOSS_KIND: scenario.workType,
        },
        otherWorkKindProcessLossTestName,
      );
      const replayResult = await waitForExit(replay, 45_000);
      expect(replayResult.code, replayResult.output).toBe(0);
      await scenario.assertCommitted();

      const settled = await manager.consumers.info(
        'MYOTA_GEODATA_WORK',
        scenario.durable,
      );
      expect(settled.num_pending).toBe(0);
      expect(settled.num_ack_pending).toBe(0);
      expect(settled.delivered?.consumer_seq).toBeGreaterThanOrEqual(2);
    }
  } finally {
    if (interrupted && interrupted.exitCode === null) {
      killWorkerProcessTree(interrupted);
      await waitForExit(interrupted).catch(() => undefined);
    }
    await publisher?.drain().catch(() => undefined);
    if (server) await stopRecoveryJetStream(server).catch(() => undefined);
    const cleanup = await pool.connect().catch(() => undefined);
    if (cleanup) {
      try {
        await cleanup.query('BEGIN');
        await cleanup.query(
          "SELECT set_config('myota.geodata_writer','row-v1',true)",
        );
        await cleanup.query(
          `DELETE FROM outbox_event WHERE aggregate_id=ANY($1::text[])`,
          [
            [
              promotionCandidateId,
              promotionQueueId,
              promotionRunId,
              deletionJobId,
              deletionEntityId,
              enrichmentEntityId,
            ],
          ],
        );
        await cleanup.query(
          'DELETE FROM geodata_audit_event WHERE aggregate_id=$1',
          [deletionEntityId],
        );
        await cleanup.query('DELETE FROM source_reference WHERE entity_id=$1', [
          promotedEntityId,
        ]);
        await cleanup.query(
          'DELETE FROM geodata_entity_category WHERE entity_id=ANY($1::uuid[])',
          [[promotedEntityId, deletionEntityId, enrichmentEntityId]],
        );
        await cleanup.query(
          'DELETE FROM geodata_import_candidate WHERE import_run_id=$1',
          [promotionRunId],
        );
        await cleanup.query(
          `DELETE FROM source_snapshot_record WHERE manifest_id IN
             (SELECT id FROM source_snapshot_manifest WHERE import_run_id=$1)`,
          [promotionRunId],
        );
        await cleanup.query(
          'DELETE FROM source_snapshot_manifest WHERE import_run_id=$1',
          [promotionRunId],
        );
        await cleanup.query(
          'DELETE FROM geodata_import_processing_queue WHERE id=$1',
          [promotionQueueId],
        );
        await cleanup.query('DELETE FROM import_run WHERE id=$1', [
          promotionRunId,
        ]);
        await cleanup.query(
          "DELETE FROM geodata_control_record WHERE kind='entityDeletionJobs' AND id=$1",
          [deletionJobId],
        );
        await cleanup.query(
          'DELETE FROM geodata_entity WHERE id=ANY($1::uuid[])',
          [[promotedEntityId, deletionEntityId, enrichmentEntityId]],
        );
        await cleanup.query(
          'DELETE FROM entity_type WHERE programme_id IS NULL AND code=$1',
          [promotionEntityTypeCode],
        );
        await cleanup.query('COMMIT');
      } catch (error) {
        await cleanup.query('ROLLBACK').catch(() => undefined);
        cleanupError = error;
      } finally {
        cleanup.release();
      }
    }
    await pool.end().catch((error: unknown) => {
      cleanupError ??= error;
    });
    await rm(directory, { recursive: true, force: true }).catch(
      (error: unknown) => {
        cleanupError ??= error;
      },
    );
    for (const [name, value] of savedEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  if (cleanupError) throw cleanupError;
}

async function verifyClaimProcessLossRecovery() {
  const databaseUrl = process.env.GEO_DATABASE_URL;
  if (!databaseUrl) throw new Error('GEO_DATABASE_URL is required');
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname)
  )
    throw new Error('Geodata claim recovery requires local Postgres');

  const directory = await mkdtemp(join(tmpdir(), 'myota-geodata-claim-loss-'));
  const natsPort = await reserveLocalPort();
  const healthPort = await reserveLocalPort();
  const natsUrl = `nats://127.0.0.1:${natsPort}`;
  const importRunId = randomUUID();
  const promotionRunId = randomUUID();
  const promotionQueueId = randomUUID();
  const promotionCandidateId = randomUUID();
  const promotedEntityId = randomUUID();
  const promotionEntityTypeCode = `RECOVERY_PARK_${promotionCandidateId
    .replaceAll('-', '')
    .slice(0, 8)
    .toUpperCase()}`;
  const deletionJobId = randomUUID();
  const deletionEntityId = randomUUID();
  const enrichmentEntityId = randomUUID();
  const enrichmentRequestId = randomUUID();
  const geometry = { type: 'Point', coordinates: [7, 46] };
  const geometryHash = createHash('sha256')
    .update(stringifyJsonWithBigInts(geometry))
    .digest('hex');
  const sourceChunks = recoveryFeatureChunks(importRunId, 2);
  const source = Buffer.concat(sourceChunks);
  const sourceHash = createHash('sha256').update(source).digest('hex');
  const savedEnvironment = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries({
    NATS_URL: natsUrl,
    GEO_DATABASE_URL: databaseUrl,
    GEODATA_WORKER_HEALTH_PORT: String(healthPort),
    GEODATA_WORKER_MAX_ACK_PENDING: '1',
    GEODATA_WORKER_ACK_WAIT_SECONDS: '2',
    GEODATA_WORKER_MAX_DELIVERIES: '10',
    MYOTA_ACTIVITY_URL: 'http://activity.fixture.test',
    BIGDATACLOUD_API_KEY: 'recovery-test-key',
    BIGDATACLOUD_REVERSE_GEOCODE_URL: 'https://geocoder.fixture.test/reverse',
    MYOTA_GEO_WORKER_CLAIM_LOSS_RUN_ID: importRunId,
  })) {
    savedEnvironment.set(name, process.env[name]);
    process.env[name] = value;
  }

  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl, max: 5 });
  let server: ChildProcess | undefined;
  let publisher: Awaited<ReturnType<typeof connect>> | undefined;
  let interrupted:
    ReturnType<typeof spawnProcessLossBeforeAckWorker> | undefined;
  let cleanupError: unknown;

  try {
    server = await startRecoveryJetStream(natsPort, directory);
    publisher = await connect({
      servers: natsUrl,
      name: 'geodata-claim-loss-publisher',
    });
    const manager = await jetstreamManager(publisher);
    await manager.streams.add({
      name: 'MYOTA_GEODATA_WORK',
      subjects: ['myota.work.geodata.>'],
      retention: RetentionPolicy.Workqueue,
      storage: StorageType.File,
      num_replicas: 1,
      max_age: 86_400_000_000_000,
      max_bytes: 16 * 1024 * 1024,
      max_msgs: 100,
      max_msg_size: 900_000,
    } as StreamConfig);
    const durables = [
      ['geodata-preprocessing-v1', 'myota.work.geodata.import-preprocess.v1'],
      ['geodata-import-promotion-v1', 'myota.work.geodata.import-promotion.v1'],
      ['geodata-entity-deletion-v1', 'myota.work.geodata.entity-delete.v1'],
      [
        'geodata-location-enrichment-v1',
        'myota.work.geodata.location-enrichment.v1',
      ],
    ] as const;
    for (const [durable, subject] of durables) {
      const policy = geodataConsumerPolicy(durable);
      await manager.consumers.add('MYOTA_GEODATA_WORK', {
        durable_name: durable,
        filter_subject: subject,
        deliver_policy: DeliverPolicy.All,
        ack_policy: AckPolicy.Explicit,
        replay_policy: ReplayPolicy.Instant,
        ack_wait: policy.ackWaitSeconds * 1_000_000_000,
        max_deliver: policy.maxDeliveries,
        max_ack_pending: policy.maxPending,
        max_waiting: 1,
        num_replicas: 0,
      } as ConsumerConfig);
    }

    const fixture = await pool.connect();
    try {
      await fixture.query('BEGIN');
      await fixture.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await fixture.query(
        `INSERT INTO import_run
          (id,adapter_code,source_metadata,status,source_key,source_hash)
         VALUES ($1,'MANUAL',$2::jsonb,'QUEUED',$3,$4)`,
        [
          importRunId,
          stringifyJsonWithBigInts({
            source: { name: `claim-loss-${importRunId}` },
            sourceObject: {
              bucket: 'recovery-test',
              key: `${importRunId}.geojson`,
            },
            filename: `${importRunId}.geojson`,
            format: 'GEOJSON',
            entityTypes: ['TEST_PARK'],
          }),
          `claim-loss/${importRunId}`,
          sourceHash,
        ],
      );
      await fixture.query(
        `INSERT INTO import_run
          (id,adapter_code,source_metadata,status,source_key,source_hash)
         VALUES ($1,'MANUAL',$2::jsonb,'PREPROCESSED',$3,$4)`,
        [
          promotionRunId,
          stringifyJsonWithBigInts({
            source: { name: `promotion-claim-loss-${promotionRunId}` },
          }),
          `promotion-claim-loss/${promotionRunId}`,
          'b'.repeat(64),
        ],
      );
      await fixture.query(
        `INSERT INTO geodata_import_processing_queue
          (id,import_run_id,candidate_ids,target_status,requested_by)
         VALUES ($1,$2,$3::jsonb,'CANDIDATE','recovery-test')`,
        [
          promotionQueueId,
          promotionRunId,
          stringifyJsonWithBigInts([promotionCandidateId]),
        ],
      );
      await fixture.query(
        `INSERT INTO geodata_import_candidate
          (id,import_run_id,ordinal,planned_entity_id,entity_type_codes,name,geom,
           candidate_source,source_ref,source_hash,entity_payload,validation_status,
           target_status,validated_by,validated_at,processing_queue_id)
         VALUES ($1,$2,1,$3,$10::jsonb,'Claim loss park',
           ST_SetSRID(ST_GeomFromGeoJSON($4),4326),$5::jsonb,$6,$7,$8::jsonb,
           'CONFIRMED','CANDIDATE','recovery-test',now(),$9)`,
        [
          promotionCandidateId,
          promotionRunId,
          promotedEntityId,
          stringifyJsonWithBigInts(geometry),
          stringifyJsonWithBigInts({ name: 'claim loss fixture' }),
          `promotion-${promotionCandidateId}`,
          'c'.repeat(64),
          stringifyJsonWithBigInts({
            geometry,
            candidateSource: { name: 'claim loss fixture' },
          }),
          promotionQueueId,
          stringifyJsonWithBigInts([promotionEntityTypeCode]),
        ],
      );
      await fixture.query(
        `INSERT INTO geodata_entity
          (id,name,lifecycle_status,geom,centroid,public_properties)
         VALUES ($1,'claim-loss-deletion-target','CANDIDATE',
           ST_SetSRID(ST_MakePoint(7,46),4326),
           ST_SetSRID(ST_MakePoint(7,46),4326)::geography,'{}'::jsonb)`,
        [deletionEntityId],
      );
      await fixture.query(
        `INSERT INTO geodata_control_record(kind,id,payload,updated_at)
         VALUES ('entityDeletionJobs',$1,$2::jsonb,now())`,
        [
          deletionJobId,
          stringifyJsonWithBigInts({
            id: deletionJobId,
            entityId: deletionEntityId,
            requestedBy: 'recovery-test',
            status: 'QUEUED',
            leaseUntil: null,
            executionClaims: {
              sub: 'recovery-test',
              scp: [],
              roles: [{ role: 'GLOBAL_OPERATOR' }],
            },
          }),
        ],
      );
      await fixture.query(
        `INSERT INTO geodata_entity
          (id,name,lifecycle_status,geom,centroid,public_properties)
         VALUES ($1,'claim-loss-enrichment-target','APPROVED',
           ST_SetSRID(ST_MakePoint(7,46),4326),
           ST_SetSRID(ST_MakePoint(7,46),4326)::geography,$2::jsonb)`,
        [
          enrichmentEntityId,
          stringifyJsonWithBigInts({
            locationEnrichmentRequestId: enrichmentRequestId,
            locationEnrichmentGeometryHash: geometryHash,
            locationEnrichmentStatus: 'QUEUED',
            locationEnrichmentOnlyMissing: true,
            locationEnrichmentReason: 'claim-loss-recovery',
            locationEnrichmentRequestedBy: 'recovery-test',
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

    const expireClaimWithWriter = async (sql: string, values: unknown[]) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          "SELECT set_config('myota.geodata_writer','row-v1',true)",
        );
        await client.query(sql, values);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    };

    const scenarios = [
      {
        workType: 'geodata.import-preprocess.v1',
        durable: 'geodata-preprocessing-v1',
        workId: importRunId,
        aggregate: { type: 'import_run', id: importRunId },
        payload: { importRunId },
        assertClaimed: async () => {
          const result = await pool.query(
            `SELECT run.status,run.attempt_count,count(candidate.ordinal)::int AS candidates
             FROM import_run run LEFT JOIN geodata_import_candidate candidate
               ON candidate.import_run_id=run.id
             WHERE run.id=$1 GROUP BY run.id`,
            [importRunId],
          );
          expect(result.rows[0]).toMatchObject({
            status: 'PROCESSING',
            attempt_count: 1,
            candidates: 0,
          });
        },
        expireClaim: () =>
          expireClaimWithWriter(
            `UPDATE import_run SET lease_until=now()-interval '1 second'
             WHERE id=$1`,
            [importRunId],
          ),
        assertFinal: async () => {
          const result = await pool.query(
            `SELECT run.status,run.attempt_count,count(candidate.ordinal)::int AS candidates,
                count(DISTINCT candidate.ordinal)::int AS distinct_ordinals
             FROM import_run run LEFT JOIN geodata_import_candidate candidate
               ON candidate.import_run_id=run.id
             WHERE run.id=$1 GROUP BY run.id`,
            [importRunId],
          );
          expect(result.rows[0]).toMatchObject({
            status: 'PREPROCESSED',
            attempt_count: 2,
            candidates: 2,
            distinct_ordinals: 2,
          });
        },
      },
      {
        workType: 'geodata.import-promotion.v1',
        durable: 'geodata-import-promotion-v1',
        workId: promotionQueueId,
        aggregate: { type: 'import_processing_queue', id: promotionQueueId },
        payload: { queueId: promotionQueueId },
        assertClaimed: async () => {
          const result = await pool.query(
            `SELECT queue.status,queue.attempt_count,candidate.validation_status,
                count(entity.id)::int AS entities
             FROM geodata_import_processing_queue queue
             JOIN geodata_import_candidate candidate ON candidate.id=$2
             LEFT JOIN geodata_entity entity ON entity.id=$3
             WHERE queue.id=$1
             GROUP BY queue.id,candidate.validation_status`,
            [promotionQueueId, promotionCandidateId, promotedEntityId],
          );
          expect(result.rows[0]).toMatchObject({
            status: 'PROCESSING',
            attempt_count: 1,
            validation_status: 'CONFIRMED',
            entities: 0,
          });
        },
        expireClaim: () =>
          expireClaimWithWriter(
            `UPDATE geodata_import_processing_queue
             SET lease_until=now()-interval '1 second' WHERE id=$1`,
            [promotionQueueId],
          ),
        assertFinal: async () => {
          const result = await pool.query(
            `SELECT queue.status,queue.attempt_count,candidate.validation_status,
                candidate.processed_entity_id::text AS entity_id,
                entity.lifecycle_status,
                (SELECT count(*)::int FROM source_reference
                 WHERE entity_id=entity.id) AS source_ref_count,
                (SELECT count(*)::int FROM outbox_event
                 WHERE event_type='geodata.import.processing.completed.v1'
                   AND aggregate_id=queue.id::text) AS completion_facts
             FROM geodata_import_processing_queue queue
             JOIN geodata_import_candidate candidate ON candidate.id=$2
             LEFT JOIN geodata_entity entity ON entity.id=$3
             WHERE queue.id=$1`,
            [promotionQueueId, promotionCandidateId, promotedEntityId],
          );
          expect(result.rows[0]).toMatchObject({
            status: 'COMPLETED',
            attempt_count: 2,
            validation_status: 'PROCESSED',
            entity_id: promotedEntityId,
            lifecycle_status: 'CANDIDATE',
            source_ref_count: 1,
            completion_facts: 1,
          });
        },
      },
      {
        workType: 'geodata.entity-delete.v1',
        durable: 'geodata-entity-deletion-v1',
        workId: deletionJobId,
        aggregate: { type: 'entity_deletion_job', id: deletionJobId },
        payload: { jobId: deletionJobId },
        assertClaimed: async () => {
          const result = await pool.query(
            `SELECT payload->>'status' AS status,
                (SELECT count(*)::int FROM geodata_entity WHERE id=$2) AS entities,
                (SELECT count(*)::int FROM geodata_audit_event WHERE aggregate_id=$3) AS audit
             FROM geodata_control_record WHERE kind='entityDeletionJobs' AND id=$1`,
            [deletionJobId, deletionEntityId, deletionEntityId],
          );
          expect(result.rows[0]).toEqual({
            status: 'PROCESSING',
            entities: 1,
            audit: 0,
          });
        },
        expireClaim: () =>
          expireClaimWithWriter(
            `UPDATE geodata_control_record
             SET payload=jsonb_set(payload,'{leaseUntil}',to_jsonb(now()-interval '1 second')),
                 updated_at=now()
             WHERE kind='entityDeletionJobs' AND id=$1`,
            [deletionJobId],
          ),
        assertFinal: async () => {
          const result = await pool.query(
            `SELECT payload->>'status' AS status,
                (SELECT count(*)::int FROM geodata_entity WHERE id=$3) AS entities,
                (SELECT count(*)::int FROM geodata_audit_event WHERE aggregate_id=$2) AS audit,
                (SELECT count(*)::int FROM outbox_event
                 WHERE event_type IN ('geodata.entity.deleted.v1',
                   'geodata.entity-deletion-job.completed.v1')
                   AND aggregate_id IN ($1,$2)) AS events
             FROM geodata_control_record WHERE kind='entityDeletionJobs' AND id=$1`,
            [deletionJobId, deletionEntityId, deletionEntityId],
          );
          expect(result.rows[0]).toEqual({
            status: 'COMPLETED',
            entities: 0,
            audit: 1,
            events: 2,
          });
        },
      },
      {
        workType: 'geodata.location-enrichment.v1',
        durable: 'geodata-location-enrichment-v1',
        workId: enrichmentRequestId,
        aggregate: { type: 'entity', id: enrichmentEntityId },
        payload: {
          entityId: enrichmentEntityId,
          requestId: enrichmentRequestId,
          geometryHash,
          onlyMissing: true,
          reason: 'claim-loss-recovery',
        },
        assertClaimed: async () => {
          const result = await pool.query(
            `SELECT public_properties->>'locationEnrichmentStatus' AS status,
                (SELECT count(*)::int FROM outbox_event
                 WHERE event_type='geodata.entity.location-enriched.v1'
                   AND aggregate_id=$2::text) AS events
             FROM geodata_entity WHERE id=$1`,
            [enrichmentEntityId, enrichmentEntityId],
          );
          expect(result.rows[0]).toEqual({ status: 'PROCESSING', events: 0 });
        },
        expireClaim: () =>
          expireClaimWithWriter(
            `UPDATE geodata_entity SET location_work_dispatched_at=now()-interval '1 second'
             WHERE id=$1`,
            [enrichmentEntityId],
          ),
        assertFinal: async () => {
          const result = await pool.query(
            `SELECT public_properties->>'locationEnrichmentStatus' AS status,
                (SELECT count(*)::int FROM outbox_event
                 WHERE event_type='geodata.entity.location-enriched.v1'
                   AND aggregate_id=$2::text) AS events
             FROM geodata_entity WHERE id=$1`,
            [enrichmentEntityId, enrichmentEntityId],
          );
          expect(result.rows[0]).toEqual({ status: 'COMPLETED', events: 1 });
        },
      },
    ] as const;

    for (const scenario of scenarios) {
      await publishGeodataWork(
        publisher,
        scenario.workType,
        scenario.workId,
        scenario.aggregate,
        scenario.payload,
      );
      interrupted = spawnProcessLossBeforeAckWorker(
        {
          ...process.env,
          MYOTA_GEO_WORKER_RECOVERY_TEST: '1',
          MYOTA_GEO_WORKER_CLAIM_LOSS_PHASE: 'interrupt',
          MYOTA_GEO_WORKER_CLAIM_LOSS_KIND: scenario.workType,
        },
        claimProcessLossTestName,
      );
      await waitForOutput(
        interrupted,
        `CLAIMED_BEFORE_PROCESS:${scenario.workType}`,
        45_000,
      );
      await scenario.assertClaimed();
      killWorkerProcessTree(interrupted);
      await waitForExit(interrupted);
      interrupted = undefined;

      const pending = await manager.consumers.info(
        'MYOTA_GEODATA_WORK',
        scenario.durable,
      );
      expect(pending.num_ack_pending).toBe(1);
      await scenario.expireClaim();
      const replay = spawnProcessLossBeforeAckWorker(
        {
          ...process.env,
          MYOTA_GEO_WORKER_RECOVERY_TEST: '1',
          MYOTA_GEO_WORKER_CLAIM_LOSS_PHASE: 'settle',
          MYOTA_GEO_WORKER_CLAIM_LOSS_KIND: scenario.workType,
        },
        claimProcessLossTestName,
      );
      const replayResult = await waitForExit(replay, 60_000);
      expect(replayResult.code, replayResult.output).toBe(0);
      await scenario.assertFinal();

      const settled = await manager.consumers.info(
        'MYOTA_GEODATA_WORK',
        scenario.durable,
      );
      expect(settled.num_pending).toBe(0);
      expect(settled.num_ack_pending).toBe(0);
      expect(settled.delivered?.consumer_seq).toBeGreaterThanOrEqual(2);
    }
  } finally {
    if (interrupted && interrupted.exitCode === null) {
      killWorkerProcessTree(interrupted);
      await waitForExit(interrupted).catch(() => undefined);
    }
    await publisher?.drain().catch(() => undefined);
    if (server) await stopRecoveryJetStream(server).catch(() => undefined);
    const cleanup = await pool.connect().catch(() => undefined);
    if (cleanup) {
      try {
        await cleanup.query('BEGIN');
        await cleanup.query(
          "SELECT set_config('myota.geodata_writer','row-v1',true)",
        );
        await cleanup.query(
          `DELETE FROM outbox_event WHERE aggregate_id=ANY($1::text[])`,
          [
            [
              importRunId,
              promotionQueueId,
              promotionRunId,
              deletionJobId,
              deletionEntityId,
              enrichmentEntityId,
              promotedEntityId,
            ],
          ],
        );
        await cleanup.query(
          'DELETE FROM geodata_audit_event WHERE aggregate_id=$1',
          [deletionEntityId],
        );
        await cleanup.query('DELETE FROM source_reference WHERE entity_id=$1', [
          promotedEntityId,
        ]);
        await cleanup.query(
          'DELETE FROM geodata_entity_category WHERE entity_id=ANY($1::uuid[])',
          [[promotedEntityId, deletionEntityId, enrichmentEntityId]],
        );
        await cleanup.query(
          'DELETE FROM geodata_import_candidate WHERE import_run_id=ANY($1::uuid[])',
          [[importRunId, promotionRunId]],
        );
        await cleanup.query(
          `DELETE FROM source_snapshot_record WHERE manifest_id IN
             (SELECT id FROM source_snapshot_manifest
              WHERE import_run_id=ANY($1::uuid[]))`,
          [[importRunId, promotionRunId]],
        );
        await cleanup.query(
          'DELETE FROM source_snapshot_manifest WHERE import_run_id=ANY($1::uuid[])',
          [[importRunId, promotionRunId]],
        );
        await cleanup.query(
          'DELETE FROM geodata_import_processing_queue WHERE id=$1',
          [promotionQueueId],
        );
        await cleanup.query('DELETE FROM import_run WHERE id=ANY($1::uuid[])', [
          [importRunId, promotionRunId],
        ]);
        await cleanup.query(
          "DELETE FROM geodata_control_record WHERE kind='entityDeletionJobs' AND id=$1",
          [deletionJobId],
        );
        await cleanup.query(
          'DELETE FROM geodata_entity WHERE id=ANY($1::uuid[])',
          [[promotedEntityId, deletionEntityId, enrichmentEntityId]],
        );
        await cleanup.query(
          'DELETE FROM entity_type WHERE programme_id IS NULL AND code=$1',
          [promotionEntityTypeCode],
        );
        await cleanup.query('COMMIT');
      } catch (error) {
        await cleanup.query('ROLLBACK').catch(() => undefined);
        cleanupError = error;
      } finally {
        cleanup.release();
      }
    }
    await pool.end().catch((error: unknown) => {
      cleanupError ??= error;
    });
    await rm(directory, { recursive: true, force: true }).catch(
      (error: unknown) => {
        cleanupError ??= error;
      },
    );
    for (const [name, value] of savedEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  if (cleanupError) throw cleanupError;
}

async function runClaimLossWorkerPhase() {
  const databaseUrl = process.env.GEO_DATABASE_URL;
  const natsUrl = process.env.NATS_URL;
  const phase = process.env.MYOTA_GEO_WORKER_CLAIM_LOSS_PHASE;
  const workType = process.env.MYOTA_GEO_WORKER_CLAIM_LOSS_KIND;
  const importRunId = process.env.MYOTA_GEO_WORKER_CLAIM_LOSS_RUN_ID;
  if (!databaseUrl || !natsUrl || !phase || !workType || !importRunId)
    throw new Error('Geodata claim-loss worker phase settings are required');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('activity.fixture.test/'))
      return new Response('{}', { status: 200 });
    if (url.includes('geocoder.fixture.test/'))
      return new Response('{}', { status: 200 });
    return originalFetch(input, init);
  };
  const originalSend = Object.getOwnPropertyDescriptor(
    S3Client.prototype,
    'send',
  )?.value as typeof S3Client.prototype.send;
  S3Client.prototype.send = (async (command: unknown) => {
    if (!(command instanceof GetObjectCommand))
      throw new Error('unexpected S3 command in claim-loss recovery fixture');
    return { Body: Readable.from(recoveryFeatureChunks(importRunId, 2)) };
  }) as typeof S3Client.prototype.send;

  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const worker = new GeodataWorkerService(
    new GeodataWorkRepository(pool),
    new GeodataPromotionRepository(pool, new GeodataPromotionScoring()),
    new GeodataEnrichmentRepository(pool),
    new GeodataDeletionRepository(pool),
    new GeodataRetentionRepository(pool),
    pool,
  );
  const internalWorker = worker as unknown as {
    claim(
      workType: string,
      envelope: Record<string, unknown>,
    ): Promise<unknown>;
  };
  const claimWork = internalWorker.claim.bind(worker);
  internalWorker.claim = async (currentWorkType, envelope) => {
    const job = await claimWork(currentWorkType, envelope);
    if (phase === 'interrupt' && currentWorkType === workType && job !== null) {
      process.stdout.write(`CLAIMED_BEFORE_PROCESS:${workType}\n`);
      await new Promise<void>(() => undefined);
    }
    return job;
  };

  let monitor: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await worker.onModuleInit();
    if (phase === 'interrupt') await new Promise<void>(() => undefined);
    monitor = await connect({
      servers: natsUrl,
      name: `geodata-claim-loss-${phase}-monitor`,
    });
    const manager = await jetstreamManager(monitor);
    const durableByWorkType: Record<string, string> = {
      'geodata.import-preprocess.v1': 'geodata-preprocessing-v1',
      'geodata.import-promotion.v1': 'geodata-import-promotion-v1',
      'geodata.entity-delete.v1': 'geodata-entity-deletion-v1',
      'geodata.location-enrichment.v1': 'geodata-location-enrichment-v1',
    };
    const durable = durableByWorkType[workType];
    if (!durable) throw new Error(`Unsupported recovery work kind ${workType}`);
    await waitForRecovery(async () => {
      const info = await manager.consumers.info('MYOTA_GEODATA_WORK', durable);
      return (
        info.delivered?.consumer_seq >= 2 &&
        info.num_pending === 0 &&
        info.num_ack_pending === 0
      );
    }, `Geodata ${workType} claim-loss redelivery did not settle`);
  } finally {
    await worker.onModuleDestroy().catch(() => undefined);
    await monitor?.drain().catch(() => undefined);
    await pool.end();
    globalThis.fetch = originalFetch;
    S3Client.prototype.send = originalSend;
  }
}

async function runOtherWorkKindProcessLossWorkerPhase() {
  const databaseUrl = process.env.GEO_DATABASE_URL;
  const natsUrl = process.env.NATS_URL;
  const phase = process.env.MYOTA_GEO_WORKER_OTHER_PROCESS_LOSS_PHASE;
  const workType = process.env.MYOTA_GEO_WORKER_OTHER_PROCESS_LOSS_KIND;
  if (!databaseUrl || !natsUrl || !phase || !workType)
    throw new Error('Geodata work-kind process-loss settings are required');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('activity.fixture.test/'))
      return new Response('{}', { status: 200 });
    if (url.includes('geocoder.fixture.test/'))
      return new Response('{}', { status: 200 });
    return originalFetch(input, init);
  };
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const worker = new GeodataWorkerService(
    new GeodataWorkRepository(pool),
    new GeodataPromotionRepository(pool, new GeodataPromotionScoring()),
    new GeodataEnrichmentRepository(pool),
    new GeodataDeletionRepository(pool),
    new GeodataRetentionRepository(pool),
    pool,
  );
  const internalWorker = worker as unknown as {
    process(workType: string, job: unknown, message: unknown): Promise<void>;
  };
  const processWork = internalWorker.process.bind(worker);
  internalWorker.process = async (currentWorkType, job, message) => {
    await processWork(currentWorkType, job, message);
    if (phase === 'interrupt' && currentWorkType === workType) {
      process.stdout.write(`COMMITTED_BEFORE_ACK:${workType}\n`);
      await new Promise<void>(() => undefined);
    }
  };

  let monitor: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await worker.onModuleInit();
    if (phase === 'interrupt') await new Promise<void>(() => undefined);
    monitor = await connect({
      servers: natsUrl,
      name: `geodata-work-kind-${phase}-monitor`,
    });
    const manager = await jetstreamManager(monitor);
    const durableByWorkType: Record<string, string> = {
      'geodata.import-promotion.v1': 'geodata-import-promotion-v1',
      'geodata.entity-delete.v1': 'geodata-entity-deletion-v1',
      'geodata.location-enrichment.v1': 'geodata-location-enrichment-v1',
    };
    const durable = durableByWorkType[workType];
    if (!durable) throw new Error(`Unsupported recovery work kind ${workType}`);
    await waitForRecovery(async () => {
      const info = await manager.consumers.info('MYOTA_GEODATA_WORK', durable);
      return (
        info.delivered?.consumer_seq >= 2 &&
        info.num_pending === 0 &&
        info.num_ack_pending === 0
      );
    }, `Geodata ${workType} redelivery did not settle`);
  } finally {
    await worker.onModuleDestroy().catch(() => undefined);
    await monitor?.drain().catch(() => undefined);
    await pool.end();
    globalThis.fetch = originalFetch;
  }
}

async function verifyTerminalDeadLetterRecovery() {
  const databaseUrl = process.env.GEO_DATABASE_URL;
  if (!databaseUrl) throw new Error('GEO_DATABASE_URL is required');
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname)
  )
    throw new Error(
      'dead-letter recovery qualification requires local Postgres',
    );

  const directory = await mkdtemp(join(tmpdir(), 'myota-geodata-dead-letter-'));
  const natsPort = await reserveLocalPort();
  const natsUrl = `nats://127.0.0.1:${natsPort}`;
  const workId = randomUUID();
  let deadLetterId: string | undefined;
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const savedNatsUrl = process.env.NATS_URL;
  let server: ChildProcess | undefined;
  let publisher: Awaited<ReturnType<typeof connect>> | undefined;
  let interrupted: ReturnType<typeof spawnTerminalDeadLetterWorker> | undefined;

  try {
    server = await startRecoveryJetStream(natsPort, directory);
    process.env.NATS_URL = natsUrl;
    publisher = await connect({
      servers: natsUrl,
      name: 'geodata-dead-letter-recovery-publisher',
    });
    const manager = await jetstreamManager(publisher);
    await manager.streams.add({
      name: 'MYOTA_GEODATA_WORK',
      subjects: ['myota.work.geodata.>'],
      retention: RetentionPolicy.Workqueue,
      storage: StorageType.File,
      num_replicas: 1,
      max_age: 86_400_000_000_000,
      max_bytes: 16 * 1024 * 1024,
      max_msgs: 100,
      max_msg_size: 900_000,
    } as StreamConfig);
    await manager.consumers.add('MYOTA_GEODATA_WORK', {
      durable_name: 'geodata-preprocessing-v1',
      filter_subject: 'myota.work.geodata.import-preprocess.v1',
      deliver_policy: DeliverPolicy.All,
      ack_policy: AckPolicy.Explicit,
      replay_policy: ReplayPolicy.Instant,
      ack_wait: 1_000_000_000,
      max_deliver: 100,
      max_ack_pending: 1,
      max_waiting: 1,
      num_replicas: 0,
    } as ConsumerConfig);

    const published = await jetstream(publisher).publish(
      'myota.work.geodata.import-preprocess.v1',
      new TextEncoder().encode(
        stringifyJsonWithBigInts({
          envelopeVersion: 1,
          workId,
          workType: 'geodata.import-preprocess.v1',
          producer: 'geodata',
          createdAt: new Date().toISOString(),
          aggregate: { type: 'import_run', id: workId },
          payload: { importRunId: workId },
          unexpected: true,
        }),
      ),
    );
    deadLetterId = expectedGeodataDeadLetterId(
      'myota.work.geodata.import-preprocess.v1',
      published.seq,
    );
    const expectedDeadLetterId = deadLetterId;

    const workerEnvironment = {
      ...process.env,
      GEO_DATABASE_URL: databaseUrl,
      NATS_URL: natsUrl,
      MYOTA_GEO_WORKER_RECOVERY_TEST: '1',
    };
    interrupted = spawnTerminalDeadLetterWorker('interrupt', workerEnvironment);
    try {
      await waitForRecovery(async () => {
        if (interrupted?.exitCode !== null || interrupted?.signalCode !== null)
          throw new Error(
            `Geodata dead-letter worker exited before persistence (code ${String(interrupted.exitCode)}, signal ${String(interrupted.signalCode)})`,
          );
        const result = await pool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM dead_letter_event
           WHERE event_id=$1`,
          [expectedDeadLetterId],
        );
        return result.rows[0]?.count === 1;
      }, 'Geodata dead letter was not persisted before termination');
    } catch (error) {
      const recentDeadLetters = await pool.query(
        `SELECT event_id::text,event_type,payload,attempts
         FROM dead_letter_event
         WHERE dead_lettered_at>now()-interval '2 minutes'
         ORDER BY dead_lettered_at DESC LIMIT 5`,
      );
      throw new Error(
        `${String(error)}\n${interrupted.getOutput()}\nRecent dead letters: ${stringifyJsonWithBigInts(recentDeadLetters.rows)}`,
      );
    }
    expect(interrupted.exitCode).toBeNull();
    interrupted.kill('SIGKILL');
    await waitForExit(interrupted);

    const beforeRedelivery = await manager.consumers.info(
      'MYOTA_GEODATA_WORK',
      'geodata-preprocessing-v1',
    );
    expect(beforeRedelivery.num_ack_pending).toBe(1);

    const replay = spawnTerminalDeadLetterWorker('settle', workerEnvironment);
    const replayResult = await waitForExit(replay, 20_000);
    expect(replayResult.code, replayResult.output).toBe(0);

    const settled = await manager.consumers.info(
      'MYOTA_GEODATA_WORK',
      'geodata-preprocessing-v1',
    );
    expect(settled.num_pending).toBe(0);
    expect(settled.num_ack_pending).toBe(0);
    const deadLetters = await pool.query<{
      event_id: string;
      event_type: string;
      payload: Record<string, unknown>;
      attempts: number;
      resolved_at: Date | null;
    }>(
      `SELECT event_id::text,event_type,payload,attempts,resolved_at
       FROM dead_letter_event WHERE event_id=$1`,
      [expectedDeadLetterId],
    );
    expect(deadLetters.rows).toEqual([
      {
        event_id: expectedDeadLetterId,
        event_type: 'unknown',
        payload: {},
        attempts: 2,
        resolved_at: null,
      },
    ]);
  } finally {
    if (interrupted && interrupted.exitCode === null) {
      interrupted.kill('SIGKILL');
      await waitForExit(interrupted).catch(() => undefined);
    }
    await publisher?.drain().catch(() => undefined);
    if (server) await stopRecoveryJetStream(server).catch(() => undefined);
    if (deadLetterId)
      await pool.query('DELETE FROM dead_letter_event WHERE event_id=$1', [
        deadLetterId,
      ]);
    await pool.end();
    await rm(directory, { recursive: true, force: true });
    if (savedNatsUrl === undefined) delete process.env.NATS_URL;
    else process.env.NATS_URL = savedNatsUrl;
  }
}

async function runTerminalDeadLetterWorkerPhase() {
  const databaseUrl = process.env.GEO_DATABASE_URL;
  const natsUrl = process.env.NATS_URL;
  const phase = process.env.MYOTA_GEO_WORKER_DEAD_LETTER_PHASE;
  if (!databaseUrl || !natsUrl || !phase)
    throw new Error('Geodata dead-letter worker phase settings are required');

  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const connection = await connect({
    servers: natsUrl,
    name: `geodata-dead-letter-${phase}`,
  });

  try {
    const consumer = await jetstream(connection).consumers.get(
      'MYOTA_GEODATA_WORK',
      'geodata-preprocessing-v1',
    );
    const message = await consumer.next({ expires: 15_000 });
    if (!message) throw new Error('Geodata dead-letter redelivery was missing');
    if (phase === 'settle' && message.info.deliveryCount < 2)
      throw new Error('Geodata dead-letter message was not redelivered');

    const worker = new GeodataWorkerService(
      new GeodataWorkRepository(pool as Pool),
      {} as GeodataPromotionRepository,
      {} as GeodataEnrichmentRepository,
      {} as GeodataDeletionRepository,
      {} as GeodataRetentionRepository,
      null,
    );
    const definition = {
      workType: 'geodata.import-preprocess.v1',
      subject: 'myota.work.geodata.import-preprocess.v1',
      durable: 'geodata-preprocessing-v1',
      producers: ['geodata'],
      consumer,
      extractId: (envelope: Record<string, unknown>) => String(envelope.workId),
      claim: async () => null,
      getState: async () => null,
      process: async () => undefined,
      ackWaitSeconds: 1,
      maxPending: 1,
      maxDeliveries: 100,
    };
    const handler = worker as unknown as {
      handle(definition: unknown, message: unknown): Promise<void>;
    };
    if (phase === 'interrupt') {
      const deferredSettlement = new Proxy(message, {
        get(target, property) {
          if (property === 'term')
            return () => process.stdout.write('DEAD_LETTER_BEFORE_TERM\\n');
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      await handler.handle(definition, deferredSettlement);
      await new Promise<void>(() => undefined);
      return;
    }
    await handler.handle(definition, message);
  } finally {
    await connection.drain();
    await pool.end();
  }
}

function expectedGeodataDeadLetterId(subject: string, streamSequence: number) {
  const namespace = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex');
  const digest = createHash('sha1')
    .update(namespace)
    .update(`MYOTA_GEODATA_WORK:${subject}:${streamSequence}`)
    .digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function verifyImportObjectStoreRecovery() {
  const databaseUrl = process.env.GEO_DATABASE_URL;
  if (!databaseUrl) throw new Error('GEO_DATABASE_URL is required');
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname)
  )
    throw new Error('object-store recovery requires local Postgres');

  const directory = await mkdtemp(join(tmpdir(), 'myota-geodata-s3-recovery-'));
  const natsPort = await reserveLocalPort();
  const healthPort = await reserveLocalPort();
  const natsUrl = `nats://127.0.0.1:${natsPort}`;
  const runId = randomUUID();
  const feature = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-5.99, 37.39] },
    properties: { name: 'object-store retry fixture', sourceRef: runId },
  };
  const source = Buffer.from(
    stringifyJsonWithBigInts({
      type: 'FeatureCollection',
      features: [feature],
    }),
  );
  const sourceHash = createHash('sha256').update(source).digest('hex');
  const environment = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries({
    NATS_URL: natsUrl,
    GEO_DATABASE_URL: databaseUrl,
    GEODATA_WORKER_HEALTH_PORT: String(healthPort),
    GEODATA_WORKER_MAX_ACK_PENDING: '1',
    GEODATA_WORKER_ACK_WAIT_SECONDS: '2',
    GEODATA_WORKER_MAX_DELIVERIES: '10',
    GEODATA_WORKER_RETRY_DELAY_SECONDS: '0',
    MYOTA_GEODATA_IMPORT_BUCKET: 'geodata-object-store-recovery',
  })) {
    environment.set(name, process.env[name]);
    process.env[name] = value;
  }

  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const originalSend = S3Client.prototype.send.bind(S3Client.prototype);
  let sourceReads = 0;
  let server: ChildProcess | undefined;
  let publisher: Awaited<ReturnType<typeof connect>> | undefined;
  let worker: GeodataWorkerService | undefined;
  let operationError: unknown;

  S3Client.prototype.send = (async (command: unknown) => {
    if (!(command instanceof GetObjectCommand))
      throw new Error('unexpected S3 command in object-store recovery fixture');
    sourceReads++;
    if (sourceReads === 1)
      throw new Error('injected temporary object-store outage');
    return { Body: Readable.from([source]) };
  }) as typeof S3Client.prototype.send;

  try {
    server = await startRecoveryJetStream(natsPort, directory);
    publisher = await connect({
      servers: natsUrl,
      name: 'geodata-object-store-recovery-publisher',
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
      ['geodata-preprocessing-v1', 'myota.work.geodata.import-preprocess.v1'],
      ['geodata-import-promotion-v1', 'myota.work.geodata.import-promotion.v1'],
      ['geodata-entity-deletion-v1', 'myota.work.geodata.entity-delete.v1'],
      [
        'geodata-location-enrichment-v1',
        'myota.work.geodata.location-enrichment.v1',
      ],
    ] as const;
    for (const [durable, filterSubject] of consumers) {
      const policy = geodataConsumerPolicy(durable);
      await manager.consumers.add('MYOTA_GEODATA_WORK', {
        durable_name: durable,
        filter_subject: filterSubject,
        deliver_policy: DeliverPolicy.All,
        ack_policy: AckPolicy.Explicit,
        replay_policy: ReplayPolicy.Instant,
        ack_wait: policy.ackWaitSeconds * 1_000_000_000,
        max_deliver: policy.maxDeliveries,
        max_ack_pending: policy.maxPending,
        max_waiting: 1,
        num_replicas: 0,
      } as ConsumerConfig);
    }

    const fixture = await pool.connect();
    try {
      await fixture.query('BEGIN');
      await fixture.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await fixture.query(
        `INSERT INTO import_run
        (id,adapter_code,source_metadata,status,source_key,source_hash)
       VALUES ($1,'MANUAL',$2::jsonb,'QUEUED',$3,$4)`,
        [
          runId,
          stringifyJsonWithBigInts({
            source: { name: 'object-store recovery fixture' },
            sourceObject: {
              bucket: 'geodata-object-store-recovery',
              key: `recovery/${runId}.geojson`,
            },
            filename: `${runId}.geojson`,
            format: 'GEOJSON',
            entityTypes: ['TEST_PARK'],
          }),
          `recovery/${runId}.geojson`,
          sourceHash,
        ],
      );
      await fixture.query('COMMIT');
    } catch (error) {
      await fixture.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      fixture.release();
    }

    worker = new GeodataWorkerService(
      new GeodataWorkRepository(pool),
      new GeodataPromotionRepository(pool, new GeodataPromotionScoring()),
      new GeodataEnrichmentRepository(pool),
      new GeodataDeletionRepository(pool),
      new GeodataRetentionRepository(pool),
      pool,
    );
    await worker.onModuleInit();
    await publishGeodataWork(
      publisher,
      'geodata.import-preprocess.v1',
      runId,
      { type: 'import_run', id: runId },
      { importRunId: runId },
    );

    await waitForRecovery(async () => {
      const state = await pool.query<{
        status: string;
        attempt_count: number;
      }>('SELECT status,attempt_count FROM import_run WHERE id=$1', [runId]);
      return (
        state.rows[0]?.status === 'PREPROCESSED' &&
        state.rows[0]?.attempt_count === 2
      );
    }, 'Geodata import did not retry after the object store recovered');

    const result = await pool.query<{
      status: string;
      attempt_count: number;
      candidates: number;
      distinct_ordinals: number;
    }>(
      `SELECT run.status,run.attempt_count,
              count(candidate.ordinal)::int AS candidates,
              count(DISTINCT candidate.ordinal)::int AS distinct_ordinals
       FROM import_run run LEFT JOIN geodata_import_candidate candidate
         ON candidate.import_run_id=run.id
       WHERE run.id=$1 GROUP BY run.id`,
      [runId],
    );
    expect(result.rows[0]).toMatchObject({
      status: 'PREPROCESSED',
      attempt_count: 2,
      candidates: 1,
      distinct_ordinals: 1,
    });
    expect(sourceReads).toBe(3);
    const settled = await manager.consumers.info(
      'MYOTA_GEODATA_WORK',
      'geodata-preprocessing-v1',
    );
    expect(settled.num_pending).toBe(0);
    expect(settled.num_ack_pending).toBe(0);
    const deadLetters = await pool.query(
      'SELECT 1 FROM dead_letter_event WHERE event_id=$1',
      [runId],
    );
    expect(deadLetters.rowCount).toBe(0);
  } catch (error) {
    operationError = error;
  }

  let cleanupError: unknown;
  if (worker) await worker.onModuleDestroy().catch(() => undefined);
  S3Client.prototype.send = originalSend;
  await publisher?.drain().catch(() => undefined);
  if (server) await stopRecoveryJetStream(server).catch(() => undefined);
  try {
    const cleanup = await pool.connect();
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
      await cleanup.query(
        'DELETE FROM geodata_import_candidate WHERE import_run_id=$1',
        [runId],
      );
      await cleanup.query(
        'DELETE FROM geodata_import_candidate_stage WHERE import_run_id=$1',
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
  } catch (error) {
    cleanupError = error;
  }
  await pool.end().catch((error: unknown) => {
    cleanupError ??= error;
  });
  await rm(directory, { recursive: true, force: true });
  for (const [name, value] of environment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
}

async function verifyClusterFailover() {
  const databaseUrl = process.env.GEO_DATABASE_URL;
  if (!databaseUrl) throw new Error('GEO_DATABASE_URL is required');
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname)
  )
    throw new Error('cluster failover recovery requires local Postgres');

  const directory = await mkdtemp(join(tmpdir(), 'myota-geodata-cluster-'));
  const healthPort = await reserveLocalPort();
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const environmentNames = [
    'NATS_URL',
    'GEO_DATABASE_URL',
    'GEODATA_WORKER_HEALTH_PORT',
    'GEODATA_WORKER_MAX_ACK_PENDING',
    'GEODATA_WORKER_ACK_WAIT_SECONDS',
  ] as const;
  const savedEnvironment = new Map(
    environmentNames.map((name) => [name, process.env[name]]),
  );
  const pendingImportId = randomUUID();
  const promotionId = randomUUID();
  const deletionId = randomUUID();
  const enrichmentEntityId = randomUUID();
  const enrichmentRequestId = randomUUID();
  const processed = {
    preprocessing: [] as string[],
    promotion: [] as string[],
    deletion: [] as string[],
    enrichment: [] as string[],
  };
  let releaseProcessing: (() => void) | undefined;
  let worker: GeodataWorkerService | undefined;
  let cluster:
    Awaited<ReturnType<typeof startTestJetStreamCluster>> | undefined;
  let publisher: Awaited<ReturnType<typeof connect>> | undefined;

  const processingStarted = {
    preprocessing: createDeferred(),
    promotion: createDeferred(),
    deletion: createDeferred(),
    enrichment: createDeferred(),
  };
  let release!: () => void;
  const processingGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  releaseProcessing = release;

  const repository = {
    claim: async (importRunId: string) => ({ importRunId }),
    getRunState: async () => ({
      status: 'PROCESSING',
      leaseRemainingSeconds: 0,
    }),
    preprocess: async (run: { importRunId: string }) => {
      if (run.importRunId === pendingImportId) {
        processingStarted.preprocessing.resolve();
        await processingGate;
      }
      processed.preprocessing.push(run.importRunId);
    },
    fail: async () => undefined,
    renewHeartbeat: async () => true,
    staleCancellationIds: async () => [],
    recoverExpiredWorkDispatches: async () => ({
      preprocessing: 0,
      promotion: 0,
      deletion: 0,
      enrichment: 0,
    }),
  };
  const promotion = {
    claimPromotion: async (queueId: string) => ({ queueId }),
    getPromotionState: async () => ({
      status: 'PROCESSING',
      leaseRemainingSeconds: 0,
    }),
    processPromotion: async (job: { queueId: string }) => {
      processingStarted.promotion.resolve();
      await processingGate;
      processed.promotion.push(job.queueId);
    },
    retryPromotion: async () => undefined,
  };
  const deletions = {
    claim: async (jobId: string) => ({ jobId }),
    getDeletionState: async () => ({
      status: 'PROCESSING',
      leaseRemainingSeconds: 0,
    }),
    execute: async (job: { jobId: string }) => {
      processingStarted.deletion.resolve();
      await processingGate;
      processed.deletion.push(job.jobId);
      return true;
    },
    heartbeat: async () => true,
    persistRetry: async () => undefined,
  };
  const enrichment = {
    claim: async (entityId: string, requestId: string) => ({
      entityId,
      requestId,
    }),
    getRequestState: async (_entityId: string) => ({
      status: 'PROCESSING',
      requestId: enrichmentRequestId,
      leaseRemainingSeconds: 0,
    }),
    process: async (job: { requestId: string }) => {
      processingStarted.enrichment.resolve();
      await processingGate;
      processed.enrichment.push(job.requestId);
    },
    persistRetry: async () => undefined,
  };
  const retention = {
    purgeSweep: async () => ({ eligible: 0, uploadsExpired: 0 }),
  };

  try {
    cluster = await startTestJetStreamCluster(
      directory,
      'myota-geodata-worker-recovery',
      'geodata-worker-cluster',
    );
    process.env.NATS_URL = cluster.natsUrl;
    process.env.GEO_DATABASE_URL = databaseUrl;
    process.env.GEODATA_WORKER_HEALTH_PORT = String(healthPort);
    process.env.GEODATA_WORKER_MAX_ACK_PENDING = '1';
    process.env.GEODATA_WORKER_ACK_WAIT_SECONDS = '2';

    publisher = await connect({
      servers: cluster.natsUrl,
      name: 'geodata-worker-cluster-publisher',
      maxReconnectAttempts: -1,
      reconnectTimeWait: 100,
    });
    const manager = await jetstreamManager(publisher);
    await addTestStreamWithPlacementRetry(manager, {
      name: 'MYOTA_GEODATA_WORK',
      subjects: ['myota.work.geodata.>'],
      retention: RetentionPolicy.Workqueue,
      storage: StorageType.File,
      num_replicas: 3,
      max_age: 1_209_600_000_000_000,
      max_bytes: 16 * 1024 * 1024,
      max_msgs: 100,
      max_msg_size: 900_000,
    } as StreamConfig);
    await waitForRecovery(async () => {
      try {
        const info = await manager.streams.info('MYOTA_GEODATA_WORK');
        return (info.cluster?.replicas?.length ?? 0) >= 2;
      } catch {
        return false;
      }
    }, 'Geodata work stream did not replicate across all cluster nodes');
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
        num_replicas: 3,
      } as ConsumerConfig);
    }

    worker = new GeodataWorkerService(
      repository as never,
      promotion as never,
      enrichment as never,
      deletions as never,
      retention as never,
      pool as Pool,
    );
    await worker.onModuleInit();
    const workerState = worker as unknown as { natsUp: boolean };
    await waitForRecovery(
      () => workerState.natsUp,
      'Geodata worker did not connect to JetStream',
    );

    await publishGeodataWork(
      publisher,
      'geodata.import-preprocess.v1',
      pendingImportId,
      { type: 'import_run', id: pendingImportId },
      { importRunId: pendingImportId },
    );
    await publishGeodataWork(
      publisher,
      'geodata.import-promotion.v1',
      promotionId,
      { type: 'import_processing_queue', id: promotionId },
      { queueId: promotionId },
    );
    await publishDeletion(publisher, deletionId);
    await publishGeodataWork(
      publisher,
      'geodata.location-enrichment.v1',
      enrichmentRequestId,
      { type: 'entity', id: enrichmentEntityId },
      {
        entityId: enrichmentEntityId,
        requestId: enrichmentRequestId,
        geometryHash: 'a'.repeat(64),
        onlyMissing: true,
        reason: 'cluster-failover',
      },
    );
    await Promise.all(
      Object.values(processingStarted).map(({ promise }) => promise),
    );
    await Promise.all(
      consumers.map(([durable]) =>
        waitForRecovery(async () => {
          const consumer = await manager.consumers.info(
            'MYOTA_GEODATA_WORK',
            durable,
          );
          return consumer.num_ack_pending > 0;
        }, `Geodata ${durable} delivery was not pending before failover`),
      ),
    );

    const initialInfo = await manager.streams.info('MYOTA_GEODATA_WORK');
    const failedLeader = initialInfo.cluster?.leader;
    if (!failedLeader)
      throw new Error('Geodata work stream has no elected leader');
    await cluster.stopNode(failedLeader);
    await waitForRecovery(async () => {
      try {
        const info = await manager.streams.info('MYOTA_GEODATA_WORK');
        return Boolean(
          info.cluster?.leader && info.cluster.leader !== failedLeader,
        );
      } catch {
        return false;
      }
    }, 'Geodata work stream did not elect a replacement leader');

    release();
    releaseProcessing = undefined;
    await waitForRecovery(
      () =>
        processed.preprocessing.includes(pendingImportId) &&
        processed.promotion.includes(promotionId) &&
        processed.deletion.includes(deletionId) &&
        processed.enrichment.includes(enrichmentRequestId),
      'Geodata work did not finish after leader failover',
    );
    for (const [durable] of consumers) {
      await waitForRecovery(async () => {
        try {
          const info = await manager.consumers.info(
            'MYOTA_GEODATA_WORK',
            durable,
          );
          return info.num_pending === 0 && info.num_ack_pending === 0;
        } catch {
          return false;
        }
      }, `Geodata durable ${durable} did not settle after leader failover`);
    }
  } finally {
    releaseProcessing?.();
    if (worker) await worker.onModuleDestroy().catch(() => undefined);
    await publisher?.drain().catch(() => undefined);
    await cluster?.stopAll();
    await pool.end();
    await rm(directory, { recursive: true, force: true });
    for (const [name, value] of savedEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

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
  const directDatabaseHealth = new DatabaseHealthService(
    directDatabase as Pool,
  );
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
  const processRestartImportRunId = randomUUID();
  const settlementPromotionQueueId = randomUUID();
  const settlementDeletionJobId = randomUUID();
  const settlementEnrichmentEntityId = randomUUID();
  const settlementEnrichmentRequestId = randomUUID();
  const staleEnrichmentEntityId = randomUUID();
  const staleEnrichmentRequestId = randomUUID();
  const changedGeometryEntityId = randomUUID();
  const changedGeometryRequestId = randomUUID();
  const apiEnrichmentEntityId = randomUUID();
  let outageClaimAttempts = 0;
  let outageStateAttempts = 0;
  let processRestartClaimAttempts = 0;
  let enrichmentClaimAttempts = 0;
  let failSettlementOnce = true;
  let failPromotionSettlementOnce = true;
  let failDeletionSettlementOnce = true;
  let failEnrichmentSettlementOnce = true;
  const liveWorkRepository = new GeodataWorkRepository(databaseProbe as Pool);
  const liveEnrichmentRepository = new GeodataEnrichmentRepository(
    databaseProbe as Pool,
  );
  const livePromotionRepository = new GeodataPromotionRepository(
    databaseProbe as Pool,
    new GeodataPromotionScoring(),
  );
  const liveDeletionRepository = new GeodataDeletionRepository(
    databaseProbe as Pool,
  );
  const liveImportRunIds = new Set([
    outageImportRunId,
    settlementImportRunId,
    processRestartImportRunId,
  ]);
  const postgresContainerId = process.env.MYOTA_POSTGRES_SERVICE_CONTAINER_ID;
  let postgresContainerStopped = false;
  let postgresRestartPromise: Promise<void> | undefined;
  const workRepository = {
    claim: vi.fn(async (importRunId: string) => {
      if (liveImportRunIds.has(importRunId)) {
        if (importRunId === outageImportRunId) outageClaimAttempts++;
        if (importRunId === processRestartImportRunId)
          processRestartClaimAttempts++;
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
    claimPromotion: vi.fn(async (queueId: string) => {
      if (queueId === settlementPromotionQueueId)
        return livePromotionRepository.claimPromotion(queueId);
      return { queueId };
    }),
    getPromotionState: vi.fn(async (queueId: string) => {
      if (queueId === settlementPromotionQueueId)
        return livePromotionRepository.getPromotionState(queueId);
      return { status: 'QUEUED', leaseRemainingSeconds: 0 };
    }),
    processPromotion: vi.fn(
      async (queue: { queueId?: string; id?: string }) => {
        const queueId = queue.queueId ?? queue.id ?? '';
        if (
          queueId === settlementPromotionQueueId &&
          failPromotionSettlementOnce
        ) {
          failPromotionSettlementOnce = false;
          databaseProxy.setAvailable(false);
          throw new Error(
            'injected promotion failure before retry-state persistence',
          );
        }
        if (queueId === settlementPromotionQueueId) {
          const completion = await directDatabase.connect();
          try {
            await completion.query('BEGIN');
            await completion.query(
              "SELECT set_config('myota.geodata_writer','row-v1',true)",
            );
            await completion.query(
              `UPDATE geodata_import_processing_queue
             SET status='COMPLETED',completed_at=now(),lease_until=NULL
             WHERE id=$1 AND status='PROCESSING'`,
              [queueId],
            );
            await completion.query('COMMIT');
          } catch (error) {
            await completion.query('ROLLBACK').catch(() => undefined);
            throw error;
          } finally {
            completion.release();
          }
        }
        processedPromotions.push(queueId);
      },
    ),
    retryPromotion: vi.fn(async (queue: { id: string }, error: unknown) => {
      if (queue.id === settlementPromotionQueueId)
        return livePromotionRepository.retryPromotion(queue as never, error);
      throw new Error('unexpected promotion failure in recovery fixture');
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
      if (job.id === settlementEnrichmentEntityId) {
        const completion = await directDatabase.connect();
        try {
          await completion.query('BEGIN');
          await completion.query(
            "SELECT set_config('myota.geodata_writer','row-v1',true)",
          );
          await completion.query(
            `UPDATE geodata_entity
             SET public_properties=public_properties ||
               '{"locationEnrichmentStatus":"FAILED"}'::jsonb,
                 updated_at=now()
             WHERE id=$1 AND public_properties->>'locationEnrichmentRequestId'=$2`,
            [job.id, job.requestId],
          );
          await completion.query('COMMIT');
        } catch (error) {
          await completion.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          completion.release();
        }
      }
      processedEnrichments.push(job.requestId);
    }),
    persistRetry: vi.fn(async (job: { id: string; requestId: string }) => {
      if (job.id === settlementEnrichmentEntityId)
        return liveEnrichmentRepository.persistRetry(job);
      throw new Error('unexpected enrichment failure in recovery fixture');
    }),
  };
  const deletions = {
    claim: vi.fn(async (jobId: string) => {
      if (jobId === settlementDeletionJobId)
        return liveDeletionRepository.claim(jobId);
      return completedJobs.has(jobId) ? null : { jobId };
    }),
    getDeletionState: vi.fn(async (jobId: string) => {
      if (jobId === settlementDeletionJobId)
        return liveDeletionRepository.getDeletionState(jobId);
      return {
        status: completedJobs.has(jobId) ? 'DELETED' : 'QUEUED',
        leaseRemainingSeconds: 0,
      };
    }),
    execute: vi.fn(async (job: { id?: string; jobId?: string }) => {
      const jobId = job.jobId ?? job.id ?? '';
      if (jobId === settlementDeletionJobId && failDeletionSettlementOnce) {
        failDeletionSettlementOnce = false;
        databaseProxy.setAvailable(false);
        throw new Error(
          'injected deletion failure before retry-state persistence',
        );
      }
      if (jobId === settlementDeletionJobId) {
        const completion = await directDatabase.connect();
        try {
          await completion.query('BEGIN');
          await completion.query(
            "SELECT set_config('myota.geodata_writer','row-v1',true)",
          );
          await completion.query(
            `UPDATE geodata_control_record
             SET payload=payload || '{"status":"COMPLETED","leaseUntil":null}'::jsonb,
                 updated_at=now()
             WHERE kind='entityDeletionJobs' AND id=$1`,
            [jobId],
          );
          await completion.query('COMMIT');
        } catch (error) {
          await completion.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          completion.release();
        }
      }
      if (jobId !== settlementDeletionJobId) {
        completedJobs.add(jobId);
        executionOrder.push(jobId);
      }
      return true;
    }),
    persistRetry: vi.fn(async (job: { id: string }, error: unknown) => {
      if (job.id === settlementDeletionJobId)
        return liveDeletionRepository.persistRetry(job as never, error);
      throw new Error('unexpected deletion failure in recovery fixture');
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
        [processRestartImportRunId, 'database-process-restart'],
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
        `INSERT INTO geodata_import_processing_queue
          (id,import_run_id,candidate_ids,target_status,requested_by)
         VALUES ($1,$2,'[]'::jsonb,'CANDIDATE','recovery-test')`,
        [settlementPromotionQueueId, settlementImportRunId],
      );
      await fixture.query(
        `INSERT INTO geodata_control_record(kind,id,payload,updated_at)
         VALUES ('entityDeletionJobs',$1,$2::jsonb,now())`,
        [
          settlementDeletionJobId,
          stringifyJsonWithBigInts({
            id: settlementDeletionJobId,
            entityId: randomUUID(),
            requestedBy: 'recovery-test',
            status: 'QUEUED',
            leaseUntil: null,
            executionClaims: {
              sub: 'recovery-test',
              scp: [],
              roles: [{ role: 'GLOBAL_OPERATOR' }],
            },
          }),
        ],
      );
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
      await fixture.query(
        `INSERT INTO geodata_entity
          (id,name,lifecycle_status,geom,centroid)
         VALUES ($1,'api-enrichment-request','APPROVED',
           ST_SetSRID(ST_MakePoint(6.1234,45.6789),4326),
           ST_SetSRID(ST_MakePoint(6.1234,45.6789),4326)::geography)`,
        [apiEnrichmentEntityId],
      );
      await fixture.query('COMMIT');
    } catch (error) {
      await fixture.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      fixture.release();
    }

    const apiEnrichmentRepository =
      new GeodataEntityEnrichmentRequestRepository(
        new GeodataEntityMutationSupport(directDatabase as Pool),
      );
    const apiClaims: AccessTokenClaims = {
      sub: 'geodata-recovery-test',
      sid: randomUUID(),
      jti: randomUUID(),
      scp: [],
      exp: Math.floor(Date.now() / 1000) + 300,
      tokenType: 'access',
      roles: [{ role: 'GLOBAL_OPERATOR' }],
    };
    const apiEnrichmentResult =
      await apiEnrichmentRepository.requestLocationEnrichment(
        apiEnrichmentEntityId,
        undefined,
        undefined,
        { editorId: 'geodata-recovery-test' },
        apiClaims,
      );
    expect(apiEnrichmentResult).toMatchObject({
      status: 'QUEUED',
      queued: true,
    });
    const apiEnrichmentState = await directDatabase.query<{ status: string }>(
      "SELECT public_properties->>'locationEnrichmentStatus' AS status FROM geodata_entity WHERE id=$1",
      [apiEnrichmentEntityId],
    );
    expect(apiEnrichmentState.rows[0]?.status).toBe('QUEUED');

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

    const rejectedBeforePromotionSettlement =
      databaseProxy.rejectedConnections();
    await publishGeodataWork(
      publisher,
      'geodata.import-promotion.v1',
      settlementPromotionQueueId,
      { type: 'import_processing_queue', id: settlementPromotionQueueId },
      { queueId: settlementPromotionQueueId },
    );
    await waitForRecovery(async () => {
      const consumer = await manager.consumers.info(
        'MYOTA_GEODATA_WORK',
        'geodata-import-promotion-v1',
      );
      return (
        !failPromotionSettlementOnce &&
        databaseProxy.rejectedConnections() >
          rejectedBeforePromotionSettlement &&
        consumer.num_ack_pending > 0
      );
    }, 'Geodata worker did not retain promotion delivery while retry state was unavailable');
    databaseProxy.setAvailable(true);
    await waitForRecovery(async () => {
      const result = await directDatabase.query<{
        status: string;
        attempt_count: number;
        error: string | null;
      }>(
        'SELECT status,attempt_count,error FROM geodata_import_processing_queue WHERE id=$1',
        [settlementPromotionQueueId],
      );
      return (
        result.rows[0]?.status === 'QUEUED' &&
        result.rows[0]?.attempt_count === 1 &&
        result.rows[0]?.error ===
          'injected promotion failure before retry-state persistence'
      );
    }, 'Geodata worker did not persist the failed promotion retry after recovery');
    await waitForRecovery(async () => {
      const result = await directDatabase.query<{
        status: string;
        attempt_count: number;
      }>(
        'SELECT status,attempt_count FROM geodata_import_processing_queue WHERE id=$1',
        [settlementPromotionQueueId],
      );
      return (
        result.rows[0]?.status === 'COMPLETED' &&
        result.rows[0]?.attempt_count === 2
      );
    }, 'Geodata worker did not complete the retried promotion after PostgreSQL recovered');
    await waitForRecovery(async () => {
      const consumer = await manager.consumers.info(
        'MYOTA_GEODATA_WORK',
        'geodata-import-promotion-v1',
      );
      return consumer.num_pending === 0 && consumer.num_ack_pending === 0;
    }, 'Geodata worker did not acknowledge the retried promotion delivery');

    const rejectedBeforeDeletionSettlement =
      databaseProxy.rejectedConnections();
    await publishDeletion(publisher, settlementDeletionJobId);
    await waitForRecovery(async () => {
      const consumer = await manager.consumers.info(
        'MYOTA_GEODATA_WORK',
        'geodata-entity-deletion-v1',
      );
      return (
        !failDeletionSettlementOnce &&
        databaseProxy.rejectedConnections() >
          rejectedBeforeDeletionSettlement &&
        consumer.num_ack_pending > 0
      );
    }, 'Geodata worker did not retain deletion delivery while retry state was unavailable');
    databaseProxy.setAvailable(true);
    await waitForRecovery(async () => {
      const result = await directDatabase.query<{
        status: string;
        last_error: string | null;
      }>(
        `SELECT payload->>'status' AS status,payload->>'lastError' AS last_error
         FROM geodata_control_record WHERE kind='entityDeletionJobs' AND id=$1`,
        [settlementDeletionJobId],
      );
      return (
        result.rows[0]?.status === 'PROCESSING' &&
        result.rows[0]?.last_error ===
          'injected deletion failure before retry-state persistence'
      );
    }, 'Geodata worker did not persist deletion retry state after recovery');
    await waitForRecovery(async () => {
      const result = await directDatabase.query<{ status: string }>(
        `SELECT payload->>'status' AS status FROM geodata_control_record
         WHERE kind='entityDeletionJobs' AND id=$1`,
        [settlementDeletionJobId],
      );
      return result.rows[0]?.status === 'COMPLETED';
    }, 'Geodata worker did not complete deletion work after PostgreSQL recovered');
    await waitForRecovery(async () => {
      const consumer = await manager.consumers.info(
        'MYOTA_GEODATA_WORK',
        'geodata-entity-deletion-v1',
      );
      return consumer.num_pending === 0 && consumer.num_ack_pending === 0;
    }, 'Geodata worker did not acknowledge the retried deletion delivery');

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
    databaseProxy.setAvailable(true);
    await waitForRecovery(async () => {
      const result = await directDatabase.query<{ status: string }>(
        `SELECT public_properties->>'locationEnrichmentStatus' AS status
         FROM geodata_entity WHERE id=$1`,
        [settlementEnrichmentEntityId],
      );
      return result.rows[0]?.status === 'QUEUED';
    }, 'Geodata worker did not persist enrichment retry state after recovery');
    await waitForRecovery(async () => {
      const result = await directDatabase.query<{ status: string }>(
        `SELECT public_properties->>'locationEnrichmentStatus' AS status
         FROM geodata_entity WHERE id=$1`,
        [settlementEnrichmentEntityId],
      );
      const consumer = await manager.consumers.info(
        'MYOTA_GEODATA_WORK',
        'geodata-location-enrichment-v1',
      );
      return (
        result.rows[0]?.status === 'FAILED' &&
        consumer.num_pending === 0 &&
        consumer.num_ack_pending === 0
      );
    }, 'Geodata worker did not complete enrichment retry after PostgreSQL recovered');
    expect(enrichmentClaimAttempts).toBe(2);
    expect(processedEnrichments).toEqual([
      requestId,
      settlementEnrichmentRequestId,
    ]);

    if (postgresContainerId) {
      await stopPostgresServiceContainer(postgresContainerId);
      postgresContainerStopped = true;
      postgresRestartPromise = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await startPostgresServiceContainer(postgresContainerId);
        postgresContainerStopped = false;
        await waitForRecovery(async () => {
          try {
            await directDatabase.query('SELECT 1');
            return true;
          } catch {
            return false;
          }
        }, 'PostgreSQL did not accept connections after its restart');
      })();
      await publishGeodataWork(
        publisher,
        'geodata.import-preprocess.v1',
        processRestartImportRunId,
        { type: 'import_run', id: processRestartImportRunId },
        { importRunId: processRestartImportRunId },
      );
      await waitForRecovery(async () => {
        const consumer = await manager.consumers.info(
          'MYOTA_GEODATA_WORK',
          'geodata-preprocessing-v1',
        );
        return processRestartClaimAttempts > 0 && consumer.num_ack_pending > 0;
      }, 'Geodata worker did not retain preprocessing work during PostgreSQL process shutdown');
      await postgresRestartPromise;
      await waitForRecovery(
        () => processedPreprocessing.includes(processRestartImportRunId),
        'Geodata preprocessing did not resume after PostgreSQL process restart',
      );
      const restartedRun = await directDatabase.query<{
        status: string;
        attempt_count: number;
      }>('SELECT status,attempt_count FROM import_run WHERE id=$1', [
        processRestartImportRunId,
      ]);
      expect(restartedRun.rows[0]).toMatchObject({
        status: 'PROCESSING',
        attempt_count: 1,
      });
      expect(processRestartClaimAttempts).toBeGreaterThanOrEqual(2);
    }

    expect(executionOrder).toEqual(jobIds);
    expect(processedPreprocessing).toEqual([
      importRunId,
      outageImportRunId,
      settlementImportRunId,
      ...(postgresContainerId ? [processRestartImportRunId] : []),
    ]);
    expect(new Set(processedPromotions)).toEqual(
      new Set([queueId, settlementPromotionQueueId]),
    );
    expect(processedEnrichments).toEqual([
      requestId,
      settlementEnrichmentRequestId,
    ]);
    expect(outageClaimAttempts).toBeGreaterThanOrEqual(2);
    expect(deletions.execute).toHaveBeenCalledTimes(4);
  } finally {
    await postgresRestartPromise?.catch(() => undefined);
    if (postgresContainerStopped && postgresContainerId) {
      await startPostgresServiceContainer(postgresContainerId).catch(
        () => undefined,
      );
      postgresContainerStopped = false;
    }
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
          [
            [
              outageImportRunId,
              settlementImportRunId,
              processRestartImportRunId,
            ],
          ],
        );
        await cleanup.query(
          'DELETE FROM geodata_import_processing_queue WHERE id=$1',
          [settlementPromotionQueueId],
        );
        await cleanup.query(
          "DELETE FROM geodata_control_record WHERE kind='entityDeletionJobs' AND id=$1",
          [settlementDeletionJobId],
        );
        await cleanup.query(
          'DELETE FROM geodata_import_candidate_stage WHERE import_run_id=ANY($1::uuid[])',
          [
            [
              outageImportRunId,
              settlementImportRunId,
              processRestartImportRunId,
            ],
          ],
        );
        await cleanup.query('DELETE FROM import_run WHERE id=ANY($1::uuid[])', [
          [outageImportRunId, settlementImportRunId, processRestartImportRunId],
        ]);
        await cleanup.query('DELETE FROM geodata_entity WHERE id=$1', [
          settlementEnrichmentEntityId,
        ]);
        await cleanup.query(
          "DELETE FROM outbox_event WHERE aggregate_type='entity' AND aggregate_id=$1",
          [apiEnrichmentEntityId],
        );
        await cleanup.query(
          "DELETE FROM geodata_audit_event WHERE aggregate_type='entity' AND aggregate_id=$1",
          [apiEnrichmentEntityId],
        );
        await cleanup.query('DELETE FROM geodata_entity WHERE id=$1', [
          apiEnrichmentEntityId,
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
    await directDatabaseHealth.onModuleDestroy();
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

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
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

function spawnProcessLossBeforeAckWorker(
  environment: NodeJS.ProcessEnv,
  testName = processLossBeforeAckTestName,
) {
  const child = spawn(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      'apps/geodata-worker/src/geodata-worker-recovery.spec.ts',
      '-t',
      testName,
      '--maxWorkers=1',
      '--no-file-parallelism',
    ],
    {
      detached: true,
      env: environment,
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

function killWorkerProcessTree(
  child: ReturnType<typeof spawnProcessLossBeforeAckWorker>,
) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.pid === undefined) {
    child.kill('SIGKILL');
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    child.kill('SIGKILL');
  }
}

function spawnTerminalDeadLetterWorker(
  phase: 'interrupt' | 'settle',
  environment: NodeJS.ProcessEnv,
) {
  const child = spawn(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      'apps/geodata-worker/src/geodata-worker-recovery.spec.ts',
      '-t',
      terminalDeadLetterRecoveryTestName,
      '--maxWorkers=1',
      '--no-file-parallelism',
    ],
    {
      env: {
        ...environment,
        MYOTA_GEO_WORKER_DEAD_LETTER_PHASE: phase,
      },
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

async function waitForOutput(
  child: ReturnType<typeof spawnProcessLossBeforeAckWorker>,
  checkpoint: string,
  timeoutMilliseconds: number,
) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `worker exited before ${checkpoint}: ${child.getOutput()}`,
      );
    if (child.getOutput().includes(checkpoint)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`worker did not reach ${checkpoint}: ${child.getOutput()}`);
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
