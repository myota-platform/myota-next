import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AckPolicy,
  DeliverPolicy,
  jetstream,
  jetstreamManager,
  ReplayPolicy,
  RetentionPolicy,
  StorageType,
} from '@nats-io/jetstream';
import type { ConsumerConfig, JsMsg, StreamConfig } from '@nats-io/jetstream';
import { connect } from '@nats-io/transport-node';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { DatabaseHealthService } from '../../../libs/platform/src/database.module.js';
import { startPostgresFaultProxy } from '../../../libs/platform/src/testing/postgres-fault-proxy.js';
import {
  addTestStreamWithPlacementRetry,
  startTestJetStreamCluster,
} from '../../../libs/platform/src/testing/jetstream-cluster.js';
import {
  startPostgresServiceContainer,
  stopPostgresServiceContainer,
} from '../../../libs/platform/src/testing/postgres-service-container.js';
import { ActivityWorkRepository } from './activity-work.repository.js';
import { ActivityRetentionRepository } from './activity-retention.repository.js';
import { ActivityWorkerService } from './activity-worker.service.js';
import {
  loadOutboxRegistry,
  routeOutboxEvent,
} from '../../../libs/platform/src/outbox-routing.js';

const enabled =
  process.env.MYOTA_ACTIVITY_WORKER_RECOVERY_TEST === '1' &&
  Boolean(process.env.ACTIVITY_DATABASE_URL);

describe.skipIf(!enabled)('Activity worker connection recovery', () => {
  it('settles terminal dead-letter redelivery after process loss before ACK', async () => {
    if (process.env.MYOTA_ACTIVITY_TERMINAL_RECOVERY_PHASE === 'persist') {
      await persistTerminalFailureInChild();
      return;
    }
    await verifyTerminalFailureProcessRecovery();
  }, 90_000);

  it('recovers after PostgreSQL connection loss and JetStream restart', async () => {
    const databaseUrl = process.env.ACTIVITY_DATABASE_URL;
    if (!databaseUrl) throw new Error('ACTIVITY_DATABASE_URL is required');
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(
        new URL(databaseUrl).hostname,
      )
    )
      throw new Error('broker restart recovery requires local Postgres');

    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const poolHealth = new DatabaseHealthService(pool);
    const databaseProxy = await startPostgresFaultProxy(databaseUrl);
    const workerPool = new Pool({
      connectionString: databaseProxy.connectionString,
      max: 4,
      connectionTimeoutMillis: 1000,
    });
    const workerPoolHealth = new DatabaseHealthService(workerPool);
    const directory = await mkdtemp(join(tmpdir(), 'myota-activity-worker-'));
    const port = await reserveLocalPort();
    const natsUrl = `nats://127.0.0.1:${port}`;
    const originalNatsUrl = process.env.NATS_URL;
    const retentionEnvironmentNames = [
      'MYOTA_OBJECT_STORAGE_ENDPOINT',
      'MYOTA_ADIF_BUCKET',
      'MYOTA_ADIF_RETENTION_DAYS',
    ] as const;
    const previousRetentionEnvironment = Object.fromEntries(
      retentionEnvironmentNames.map((name) => [name, process.env[name]]),
    );
    const jobs = Array.from({ length: 5 }, () => randomUUID());
    const programmeSlugs = jobs.map((id) => `worker-restart-${id}`);
    const postgresContainerId = process.env.MYOTA_POSTGRES_SERVICE_CONTAINER_ID;
    const retentionImportId = randomUUID();
    const retentionActivationId = randomUUID();
    const retentionObjectKey = `retention/${retentionImportId}.adi`;
    let server: ReturnType<typeof spawn> | undefined;
    let retentionObjectStore:
      Awaited<ReturnType<typeof startRetentionObjectStore>> | undefined;
    let publisher: Awaited<ReturnType<typeof connect>> | undefined;
    let worker: ActivityWorkerService | undefined;
    let postgresContainerStopped = false;
    let postgresRestartPromise: Promise<void> | undefined;

    try {
      const registry = await loadOutboxRegistry();
      const activityWork = registry.work.filter(
        (item) => item.owner === 'activity-service',
      );
      const statisticsDurable = activityWork.find(
        (item) => item.workType === 'activity.statistics-rebuild.v1',
      )?.durable;
      if (!statisticsDurable)
        throw new Error('statistics rebuild durable is not registered');
      retentionObjectStore = await startRetentionObjectStore(() =>
        databaseProxy.setAvailable(false),
      );
      process.env.MYOTA_OBJECT_STORAGE_ENDPOINT = retentionObjectStore.endpoint;
      process.env.MYOTA_ADIF_BUCKET = 'myota-adif';
      process.env.MYOTA_ADIF_RETENTION_DAYS = '1';
      process.env.NATS_URL = natsUrl;
      server = await startJetStream(port, directory);
      publisher = await connect({
        servers: natsUrl,
        name: 'activity-worker-restart-publisher',
        reconnect: true,
        maxReconnectAttempts: -1,
        reconnectTimeWait: 100,
      });
      const manager = await jetstreamManager(publisher);
      await manager.streams.add({
        name: registry.activityWorkStream,
        subjects: [`${registry.activityWorkSubjectPrefix}>`],
        retention: RetentionPolicy.Workqueue,
        storage: StorageType.File,
        num_replicas: 1,
        max_age: 3_600_000_000_000,
        max_bytes: 16 * 1024 * 1024,
        max_msgs: 1000,
        max_msg_size: 1024 * 1024,
      } as StreamConfig);
      for (const item of activityWork) {
        const [maxAckPending, maxWaiting] = activityConsumerLimits(
          item.durable,
        );
        await manager.consumers.add(registry.activityWorkStream, {
          durable_name: item.durable,
          filter_subject: item.subject,
          deliver_policy: DeliverPolicy.All,
          ack_policy: AckPolicy.Explicit,
          ack_wait: activityAckWait(item.durable) * 1_000_000_000,
          max_deliver: 8,
          max_ack_pending: maxAckPending,
          max_waiting: maxWaiting,
          replay_policy: ReplayPolicy.Instant,
          num_replicas: 0,
        } as ConsumerConfig);
      }

      databaseProxy.setAvailable(false);
      const workRepository = new ActivityWorkRepository(workerPool);
      const processWork = workRepository.process.bind(workRepository);
      let injectSettlementFailure = true;
      let injectPostgresRestartFailure = true;
      workRepository.process = async (job) => {
        if (job.id === jobs[3])
          throw new Error('injected failure for terminal settlement');
        if (job.id === jobs[1] && injectSettlementFailure) {
          injectSettlementFailure = false;
          databaseProxy.setAvailable(false);
          throw new Error('injected failure before retry-state persistence');
        }
        if (
          job.id === jobs[4] &&
          postgresContainerId &&
          !postgresRestartPromise
        ) {
          await stopPostgresServiceContainer(postgresContainerId);
          postgresContainerStopped = true;
          postgresRestartPromise = (async () => {
            await delay(1500);
            await startPostgresServiceContainer(postgresContainerId);
            postgresContainerStopped = false;
            await waitFor(async () => {
              try {
                await pool.query('SELECT 1');
                return true;
              } catch {
                return false;
              }
            }, 'PostgreSQL did not accept connections after its restart');
          })();
          await postgresRestartPromise;
          if (injectPostgresRestartFailure) {
            injectPostgresRestartFailure = false;
            throw new Error('injected failure after PostgreSQL restart');
          }
        }
        return processWork(job);
      };
      worker = new ActivityWorkerService(
        workRepository,
        new ActivityRetentionRepository(workerPool),
        workerPool,
      );
      await worker.onModuleInit();
      const workerState = worker as unknown as { natsUp: boolean };
      await waitFor(
        () => workerState.natsUp,
        'worker did not connect to JetStream',
      );

      await queueStatisticsJob(pool, jobs[0]!, programmeSlugs[0]!);
      const rejectedBeforeOutage = databaseProxy.rejectedConnections();
      await publishWork(publisher, registry, jobs[0]!);
      await waitFor(async () => {
        const consumer = await manager.consumers.info(
          registry.activityWorkStream,
          statisticsDurable,
        );
        return (
          databaseProxy.rejectedConnections() > rejectedBeforeOutage &&
          consumer.num_ack_pending > 0
        );
      }, 'Activity worker did not retry a failed PostgreSQL connection');
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const waitingJob = await pool.query<{
        status: string;
        attempts: number;
      }>('SELECT status,attempts FROM activity_job WHERE id=$1', [jobs[0]]);
      expect(waitingJob.rows[0]).toMatchObject({
        status: 'QUEUED',
        attempts: 0,
      });
      databaseProxy.setAvailable(true);
      await waitForJob(pool, jobs[0]!);
      const recoveredJob = await pool.query<{ attempts: number }>(
        'SELECT attempts FROM activity_job WHERE id=$1',
        [jobs[0]],
      );
      expect(recoveredJob.rows[0]?.attempts).toBe(1);

      await queueStatisticsJob(pool, jobs[1]!, programmeSlugs[1]!);
      const rejectedBeforeSettlementOutage =
        databaseProxy.rejectedConnections();
      await publishWork(publisher, registry, jobs[1]!);
      await waitFor(async () => {
        const consumer = await manager.consumers.info(
          registry.activityWorkStream,
          statisticsDurable,
        );
        return (
          !injectSettlementFailure &&
          databaseProxy.rejectedConnections() >
            rejectedBeforeSettlementOutage &&
          consumer.num_ack_pending > 0
        );
      }, 'Activity worker did not retain the delivery while retry state was unavailable');
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const pendingRetry = await pool.query<{
        status: string;
        attempts: number;
      }>('SELECT status,attempts FROM activity_job WHERE id=$1', [jobs[1]]);
      expect(pendingRetry.rows[0]).toMatchObject({
        status: 'RUNNING',
        attempts: 1,
      });

      databaseProxy.setAvailable(true);
      await waitForQueuedJob(pool, jobs[1]!, 1);
      await makeQueuedJobAvailable(pool, jobs[1]!);
      await waitForConsumerAckPending(
        manager,
        registry.activityWorkStream,
        statisticsDurable,
        0,
      );
      // The persisted queued retry is dispatched through the same command path
      // as the outbox worker after the database recovers.
      await publishWork(publisher, registry, jobs[1]!);
      await waitForJob(pool, jobs[1]!, 30_000);

      await queueStatisticsJob(pool, jobs[3]!, programmeSlugs[3]!);
      const workInternals = workRepository as unknown as {
        failWorkJob: ActivityWorkRepository['failWorkJob'];
      };
      const failWorkJob = workInternals.failWorkJob.bind(workRepository);
      let terminalPersistenceOutageInjected = false;
      workInternals.failWorkJob = async (...args) => {
        if (!terminalPersistenceOutageInjected) {
          terminalPersistenceOutageInjected = true;
          databaseProxy.setAvailable(false);
        }
        return failWorkJob(...args);
      };
      let terminalMessageAcknowledged = false;
      let ackExtensions = 0;
      const statsWork = activityWork.find(
        (item) => item.durable === statisticsDurable,
      );
      if (!statsWork) throw new Error('statistics work is not registered');
      const terminalMessage = {
        info: { deliveryCount: 8 },
        subject: statsWork.subject,
        data: new TextEncoder().encode(
          JSON.stringify({
            envelopeVersion: 1,
            workId: jobs[3],
            workType: 'activity.statistics-rebuild.v1',
            createdAt: new Date().toISOString(),
            producer: 'activity-service',
            aggregate: { type: 'activity_job', id: jobs[3] },
            payload: { jobId: jobs[3] },
          }),
        ),
        working: () => {
          ackExtensions += 1;
        },
        ackAck: async () => {
          terminalMessageAcknowledged = true;
          return true;
        },
        nak: () => {
          throw new Error('exhausted work delivery must not be retried');
        },
        term: () => {
          throw new Error('valid work failures must not be terminated');
        },
      } as unknown as JsMsg;
      const workerInternals = worker as unknown as {
        handle(
          definition: {
            kind: string;
            workType: string;
            subject: string;
            durable: string;
          },
          message: JsMsg,
        ): Promise<void>;
      };
      const terminalSettlement = workerInternals.handle(
        {
          kind: 'STATISTICS_REBUILD',
          workType: statsWork.workType,
          subject: statsWork.subject,
          durable: statsWork.durable,
        },
        terminalMessage,
      );
      const rejectedBeforeTerminalPersistence =
        databaseProxy.rejectedConnections();
      await waitFor(
        () =>
          terminalPersistenceOutageInjected &&
          databaseProxy.rejectedConnections() >
            rejectedBeforeTerminalPersistence &&
          !terminalMessageAcknowledged,
        'Activity worker acknowledged exhausted work before terminal state recovered',
      );
      const jobDuringDeadLetterOutage = await pool.query<{
        status: string;
      }>('SELECT status FROM activity_job WHERE id=$1', [jobs[3]]);
      const deadLetterDuringOutage = await pool.query(
        'SELECT 1 FROM activity_work_dead_letter WHERE work_id=$1',
        [jobs[3]],
      );
      expect(jobDuringDeadLetterOutage.rows[0]?.status).toBe('RUNNING');
      expect(deadLetterDuringOutage.rowCount).toBe(0);
      expect(ackExtensions).toBeGreaterThan(0);
      databaseProxy.setAvailable(true);
      await terminalSettlement;
      workInternals.failWorkJob = failWorkJob;
      expect(terminalMessageAcknowledged).toBe(true);
      const settledTerminalJob = await pool.query<{
        status: string;
        last_error: string | null;
      }>('SELECT status,last_error FROM activity_job WHERE id=$1', [jobs[3]]);
      expect(settledTerminalJob.rows[0]).toMatchObject({
        status: 'FAILED',
        last_error: 'Error',
      });
      const savedWorkDeadLetter = await pool.query<{
        delivery_count: number;
        error_category: string;
      }>(
        `SELECT delivery_count,error_category FROM activity_work_dead_letter
         WHERE work_id=$1`,
        [jobs[3]],
      );
      expect(savedWorkDeadLetter.rows[0]).toEqual({
        delivery_count: 8,
        error_category: 'Error',
      });

      await stopJetStream(server);
      server = undefined;
      await waitFor(
        () => !workerState.natsUp,
        'worker did not detect broker outage',
      );

      server = await startJetStream(port, directory);
      await waitFor(
        () => workerState.natsUp,
        'worker did not reconnect to JetStream',
      );
      await waitForPublisher(publisher, registry.activityWorkStream);
      await queueStatisticsJob(pool, jobs[2]!, programmeSlugs[2]!);
      await publishWork(publisher, registry, jobs[2]!);
      await waitForJob(pool, jobs[2]!);
      const snapshots = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM activity_statistic_snapshot
         WHERE programme_slug=ANY($1::text[]) AND algorithm_version='activity-v2'`,
        [programmeSlugs],
      );
      expect(snapshots.rows[0]?.count).toBeGreaterThanOrEqual(3);

      if (postgresContainerId) {
        await queueStatisticsJob(pool, jobs[4]!, programmeSlugs[4]!);
        await publishWork(publisher, registry, jobs[4]!);
        await waitFor(
          () => Boolean(postgresRestartPromise),
          'Activity statistics rebuild did not stop PostgreSQL',
        );
        await postgresRestartPromise;
        // The queued retry and fresh outbox command commit together. Simulate
        // outbox dispatch after PostgreSQL returns, after confirming the old
        // delivery was settled.
        await waitForQueuedJob(pool, jobs[4]!, 1);
        await makeQueuedJobAvailable(pool, jobs[4]!);
        await waitForConsumerAckPending(
          manager,
          registry.activityWorkStream,
          statisticsDurable,
          0,
        );
        await publishWork(publisher, registry, jobs[4]!);
        await waitForJob(pool, jobs[4]!, 30_000);
        const restartedJob = await pool.query<{ attempts: number }>(
          'SELECT attempts FROM activity_job WHERE id=$1',
          [jobs[4]],
        );
        expect(restartedJob.rows[0]?.attempts).toBeGreaterThanOrEqual(2);
      }

      await pool.query(
        `INSERT INTO activity_activation
           (id,programme_slug,entity_id,entity_type,operator_id,operator_callsign,started_at)
         VALUES ($1,$2,'retention-entity','SOTA','retention-operator','N0CALL','2026-01-01T00:00:00Z')`,
        [retentionActivationId, `retention-${retentionImportId}`],
      );
      await pool.query(
        `INSERT INTO activity_import
           (id,activation_id,filename,object_key,bucket,sha256,content_size,status,completed_at)
         VALUES ($1,$2,'retention.adi',$3,'myota-adif',$4,1,'COMPLETED',now()-interval '3 days')`,
        [
          retentionImportId,
          retentionActivationId,
          retentionObjectKey,
          'a'.repeat(64),
        ],
      );
      const runRetention = (
        worker as unknown as { runRetention: () => Promise<void> }
      ).runRetention;
      const rejectedBeforeRetentionOutage = databaseProxy.rejectedConnections();
      const retentionLoop = runRetention.call(worker);
      await waitFor(
        () =>
          retentionObjectStore!.deletedKeys.length === 1 &&
          databaseProxy.rejectedConnections() > rejectedBeforeRetentionOutage,
        'Activity retention did not lose PostgreSQL after deleting its source object',
      );
      const markerDuringOutage = await pool.query<{
        source_deleted_at: Date | null;
      }>('SELECT source_deleted_at FROM activity_import WHERE id=$1', [
        retentionImportId,
      ]);
      expect(markerDuringOutage.rows[0]?.source_deleted_at).toBeNull();
      databaseProxy.setAvailable(true);
      await waitFor(async () => {
        const marker = await pool.query<{
          source_deleted_at: Date | null;
        }>('SELECT source_deleted_at FROM activity_import WHERE id=$1', [
          retentionImportId,
        ]);
        return (
          retentionObjectStore!.deletedKeys.length >= 2 &&
          marker.rows[0]?.source_deleted_at !== null
        );
      }, 'Activity retention did not repeat safe object deletion and persist its marker');
      expect(retentionObjectStore.deletedKeys).toEqual([
        `/${'myota-adif'}/${retentionObjectKey}`,
        `/${'myota-adif'}/${retentionObjectKey}`,
      ]);
      await worker.onModuleDestroy();
      worker = undefined;
      await retentionLoop;
    } finally {
      await postgresRestartPromise?.catch(() => undefined);
      if (postgresContainerStopped && postgresContainerId) {
        await startPostgresServiceContainer(postgresContainerId).catch(
          () => undefined,
        );
        postgresContainerStopped = false;
      }
      if (worker) await worker.onModuleDestroy().catch(() => undefined);
      await workerPoolHealth.onModuleDestroy().catch(() => undefined);
      if (publisher) await publisher.drain().catch(() => undefined);
      if (server) await stopJetStream(server).catch(() => undefined);
      await pool
        .query('DELETE FROM outbox_event WHERE event_id=ANY($1::uuid[])', [
          jobs,
        ])
        .catch(() => undefined);
      await pool
        .query(
          `DELETE FROM activity_statistic_snapshot
         WHERE programme_slug=ANY($1::text[]) AND algorithm_version='activity-v2'`,
          [programmeSlugs],
        )
        .catch(() => undefined);
      await pool
        .query(
          'DELETE FROM activity_work_dead_letter WHERE work_id=ANY($1::uuid[])',
          [jobs],
        )
        .catch(() => undefined);
      await pool
        .query('DELETE FROM activity_job WHERE id=ANY($1::uuid[])', [jobs])
        .catch(() => undefined);
      await pool
        .query('DELETE FROM activity_import WHERE id=$1', [retentionImportId])
        .catch(() => undefined);
      await pool
        .query('DELETE FROM activity_activation WHERE id=$1', [
          retentionActivationId,
        ])
        .catch(() => undefined);
      await poolHealth.onModuleDestroy();
      await databaseProxy.close();
      await rm(directory, { recursive: true, force: true });
      await retentionObjectStore?.close();
      for (const name of retentionEnvironmentNames) {
        const value = previousRetentionEnvironment[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      if (originalNatsUrl === undefined) delete process.env.NATS_URL;
      else process.env.NATS_URL = originalNatsUrl;
    }
  }, 120_000);

  it('settles pending work and dead letters after JetStream leader failover', async () => {
    const databaseUrl = process.env.ACTIVITY_DATABASE_URL;
    if (!databaseUrl) throw new Error('ACTIVITY_DATABASE_URL is required');
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(
        new URL(databaseUrl).hostname,
      )
    )
      throw new Error('cluster failover recovery requires local Postgres');

    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const poolHealth = new DatabaseHealthService(pool);
    const directory = await mkdtemp(
      join(tmpdir(), 'myota-activity-worker-cluster-'),
    );
    const healthPort = await reserveLocalPort();
    const originalNatsUrl = process.env.NATS_URL;
    const originalHealthPort = process.env.ACTIVITY_WORKER_HEALTH_PORT;
    const ids = [randomUUID(), randomUUID()];
    const programmeSlugs = ids.map((id) => `worker-cluster-${id}`);
    const savedEnvironment = new Map([
      ['NATS_URL', originalNatsUrl],
      ['ACTIVITY_WORKER_HEALTH_PORT', originalHealthPort],
    ]);
    let releaseProcessing: (() => void) | undefined;
    let cluster:
      Awaited<ReturnType<typeof startTestJetStreamCluster>> | undefined;
    let publisher: Awaited<ReturnType<typeof connect>> | undefined;
    let worker: ActivityWorkerService | undefined;
    let releaseInvalidDeadLetter: (() => void) | undefined;
    let invalidDeadLetterId: string | undefined;

    let startProcessing!: () => void;
    const processingStarted = new Promise<void>((resolve) => {
      startProcessing = resolve;
    });
    let release!: () => void;
    const processingGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    releaseProcessing = release;

    try {
      const registry = await loadOutboxRegistry();
      const activityWork = registry.work.filter(
        (item) => item.owner === 'activity-service',
      );
      cluster = await startTestJetStreamCluster(
        directory,
        'myota-activity-worker-recovery',
        'activity-worker-cluster',
      );
      process.env.NATS_URL = cluster.natsUrl;
      process.env.ACTIVITY_WORKER_HEALTH_PORT = String(healthPort);
      publisher = await connect({
        servers: cluster.natsUrl,
        name: 'activity-worker-cluster-publisher',
        maxReconnectAttempts: -1,
        reconnectTimeWait: 100,
      });
      const manager = await jetstreamManager(publisher);
      await provisionActivityWorkStream(manager, registry, activityWork);

      const workRepository = new ActivityWorkRepository(pool);
      const processWork = workRepository.process.bind(workRepository);
      const recordDeadLetter =
        workRepository.recordWorkDeadLetter.bind(workRepository);
      let releaseDeadLetter!: () => void;
      const deadLetterGate = new Promise<void>((resolve) => {
        releaseDeadLetter = resolve;
      });
      releaseInvalidDeadLetter = releaseDeadLetter;
      let deadLetterPersisted!: () => void;
      const deadLetterWritten = new Promise<void>((resolve) => {
        deadLetterPersisted = resolve;
      });
      workRepository.recordWorkDeadLetter = async (...args) => {
        await recordDeadLetter(...args);
        deadLetterPersisted();
        await deadLetterGate;
      };
      let holdFirstJob = true;
      workRepository.process = async (job) => {
        if (job.id === ids[0] && holdFirstJob) {
          holdFirstJob = false;
          startProcessing();
          await processingGate;
        }
        return processWork(job);
      };
      worker = new ActivityWorkerService(
        workRepository,
        { runSweep: async () => 0 } as unknown as ActivityRetentionRepository,
        pool,
      );
      await worker.onModuleInit();
      const workerState = worker as unknown as { natsUp: boolean };
      await waitFor(
        () => workerState.natsUp,
        'Activity worker did not connect to JetStream',
      );

      await queueStatisticsJob(pool, ids[0]!, programmeSlugs[0]!);
      await publishWork(publisher, registry, ids[0]!);
      await processingStarted;
      await waitFor(async () => {
        const consumer = await manager.consumers.info(
          registry.activityWorkStream,
          'activity-statistics-rebuild-v1',
        );
        return consumer.num_ack_pending > 0;
      }, 'Activity job delivery was not pending before failover');

      const qsoWork = activityWork.find(
        (item) => item.workType === 'activity.qso-ingestion.v1',
      );
      if (!qsoWork) throw new Error('QSO ingestion work is not registered');
      const deadLetterStarted = await pool.query<{ started_at: Date }>(
        'SELECT clock_timestamp() AS started_at',
      );
      await jetstream(publisher).publish(
        qsoWork.subject,
        new TextEncoder().encode('{"workId":"invalid"}'),
      );
      await deadLetterWritten;
      const savedInvalidDeadLetter = await pool.query<{ id: string }>(
        `SELECT id FROM activity_work_dead_letter
         WHERE subject=$1 AND error_category='invalid_envelope'
           AND work_id IS NULL AND dead_lettered_at >= $2
         ORDER BY dead_lettered_at DESC LIMIT 1`,
        [qsoWork.subject, deadLetterStarted.rows[0]!.started_at],
      );
      invalidDeadLetterId = savedInvalidDeadLetter.rows[0]?.id;
      if (!invalidDeadLetterId)
        throw new Error('Activity invalid work dead letter was not persisted');
      await waitFor(
        async () =>
          (
            await manager.consumers.info(
              registry.activityWorkStream,
              qsoWork.durable,
            )
          ).num_ack_pending === 1,
        'Activity invalid work was not pending settlement',
      );

      const initialInfo = await manager.streams.info(
        registry.activityWorkStream,
      );
      const failedLeader = initialInfo.cluster?.leader;
      if (!failedLeader)
        throw new Error('Activity work stream has no elected leader');
      if (!cluster.serverNames.includes(failedLeader))
        throw new Error(`JetStream elected an unknown leader: ${failedLeader}`);
      await cluster.stopNode(failedLeader);
      await waitFor(async () => {
        try {
          const info = await manager.streams.info(registry.activityWorkStream);
          return Boolean(
            info.cluster?.leader && info.cluster.leader !== failedLeader,
          );
        } catch {
          return false;
        }
      }, 'Activity work stream did not elect a replacement leader');

      releaseDeadLetter();
      releaseInvalidDeadLetter = undefined;
      release();
      releaseProcessing = undefined;
      await waitForJob(pool, ids[0]!);
      const firstJob = await pool.query<{ attempts: number }>(
        'SELECT attempts FROM activity_job WHERE id=$1',
        [ids[0]],
      );
      expect(firstJob.rows[0]?.attempts).toBe(1);
      await waitFor(
        async () => {
          try {
            const info = await manager.consumers.info(
              registry.activityWorkStream,
              'activity-statistics-rebuild-v1',
            );
            return info.num_pending === 0 && info.num_ack_pending === 0;
          } catch {
            return false;
          }
        },
        'Activity job delivery did not acknowledge after failover',
        30_000,
      );
      await waitForConsumerAckPending(
        manager,
        registry.activityWorkStream,
        qsoWork.durable,
        0,
      );
      const invalidDeadLetter = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM activity_work_dead_letter
         WHERE id=$1 AND error_category='invalid_envelope'`,
        [invalidDeadLetterId],
      );
      expect(invalidDeadLetter.rows[0]?.count).toBe(1);
      await pool.query('DELETE FROM activity_work_dead_letter WHERE id=$1', [
        invalidDeadLetterId,
      ]);

      await queueStatisticsJob(pool, ids[1]!, programmeSlugs[1]!);
      await publishWork(publisher, registry, ids[1]!);
      await waitForJob(pool, ids[1]!);
      for (const item of activityWork) {
        await waitFor(
          async () => {
            try {
              const info = await manager.consumers.info(
                registry.activityWorkStream,
                item.durable,
              );
              return info.num_pending === 0 && info.num_ack_pending === 0;
            } catch {
              return false;
            }
          },
          `Activity durable ${item.durable} did not settle after failover`,
          30_000,
        );
      }

      const stream = await manager.streams.info(registry.activityWorkStream);
      expect(stream.cluster?.leader).not.toBe(failedLeader);
      expect(stream.state.messages).toBe(0);
    } finally {
      releaseProcessing?.();
      releaseInvalidDeadLetter?.();
      if (worker) await worker.onModuleDestroy().catch(() => undefined);
      await publisher?.drain().catch(() => undefined);
      await cluster?.stopAll();
      await pool
        .query('DELETE FROM activity_work_dead_letter WHERE id=$1', [
          invalidDeadLetterId,
        ])
        .catch(() => undefined);
      await pool
        .query(
          `DELETE FROM activity_statistic_snapshot
           WHERE programme_slug=ANY($1::text[]) AND algorithm_version='activity-v2'`,
          [programmeSlugs],
        )
        .catch(() => undefined);
      await pool
        .query('DELETE FROM activity_job WHERE id=ANY($1::uuid[])', [ids])
        .catch(() => undefined);
      await pool
        .query(
          `DELETE FROM outbox_event
           WHERE aggregate_type='activity_job' AND aggregate_id=ANY($1::text[])`,
          [ids],
        )
        .catch(() => undefined);
      await poolHealth.onModuleDestroy().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
      for (const [name, value] of savedEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }, 90_000);

  it('confirms terminal failed-job ACK after JetStream leader failover', async () => {
    const databaseUrl = process.env.ACTIVITY_DATABASE_URL;
    if (!databaseUrl) throw new Error('ACTIVITY_DATABASE_URL is required');
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(
        new URL(databaseUrl).hostname,
      )
    )
      throw new Error('cluster failover recovery requires local Postgres');

    const pool = new Pool({ connectionString: databaseUrl, max: 3 });
    const directory = await mkdtemp(
      join(tmpdir(), 'myota-activity-terminal-cluster-'),
    );
    const jobId = randomUUID();
    const programmeSlug = `terminal-cluster-${jobId}`;
    let cluster:
      Awaited<ReturnType<typeof startTestJetStreamCluster>> | undefined;
    let publisher: Awaited<ReturnType<typeof connect>> | undefined;
    let releaseSettlement: (() => void) | undefined;
    let terminalSettlement: Promise<void> | undefined;
    let deadLetterId: string | undefined;

    try {
      const registry = await loadOutboxRegistry();
      const activityWork = registry.work.filter(
        (item) => item.owner === 'activity-service',
      );
      const statisticsWork = activityWork.find(
        (item) => item.workType === 'activity.statistics-rebuild.v1',
      );
      if (!statisticsWork)
        throw new Error('statistics rebuild work is not registered');
      cluster = await startTestJetStreamCluster(
        directory,
        'myota-activity-terminal-recovery',
        'activity-terminal-cluster',
      );
      publisher = await connect({
        servers: cluster.natsUrl,
        name: 'activity-terminal-cluster-publisher',
        maxReconnectAttempts: -1,
        reconnectTimeWait: 100,
      });
      const manager = await jetstreamManager(publisher);
      await provisionActivityWorkStream(manager, registry, activityWork);

      await queueStatisticsJob(pool, jobId, programmeSlug);
      await publishWork(publisher, registry, jobId);
      const consumer = await jetstream(publisher).consumers.get(
        registry.activityWorkStream,
        statisticsWork.durable,
      );
      const brokerMessage = await consumer.next({ expires: 5000 });
      if (!brokerMessage)
        throw new Error('terminal Activity work was not delivered');

      const repository = new ActivityWorkRepository(pool);
      repository.process = async () => {
        throw new Error('injected terminal processing failure');
      };
      const persistFailure = repository.failWorkJob.bind(repository);
      let failureCommitted!: () => void;
      const failureCommittedPromise = new Promise<void>((resolve) => {
        failureCommitted = resolve;
      });
      let releaseCommittedFailure!: () => void;
      const committedFailureGate = new Promise<void>((resolve) => {
        releaseCommittedFailure = resolve;
      });
      releaseSettlement = releaseCommittedFailure;
      repository.failWorkJob = async (...args) => {
        await persistFailure(...args);
        failureCommitted();
        await committedFailureGate;
      };

      const service = new ActivityWorkerService(
        repository,
        {} as ActivityRetentionRepository,
        pool,
      );
      const handler = service as unknown as {
        handle(
          definition: {
            kind: string;
            workType: string;
            subject: string;
            durable: string;
            consumer: never;
            maxPending: number;
          },
          message: JsMsg,
        ): Promise<void>;
      };
      // Exercise the exhausted-delivery branch while keeping broker settlement real.
      const terminalMessage = {
        subject: brokerMessage.subject,
        data: brokerMessage.data,
        info: { ...brokerMessage.info, deliveryCount: 8 },
        working: () => brokerMessage.working(),
        ackAck: () => brokerMessage.ackAck(),
        nak: (milliseconds?: number) => brokerMessage.nak(milliseconds),
      } as unknown as JsMsg;
      terminalSettlement = handler.handle(
        {
          kind: 'STATISTICS_REBUILD',
          workType: statisticsWork.workType,
          subject: statisticsWork.subject,
          durable: statisticsWork.durable,
          consumer: consumer as never,
          maxPending: 1,
        },
        terminalMessage,
      );

      await failureCommittedPromise;
      const failedJob = await pool.query<{ status: string }>(
        'SELECT status FROM activity_job WHERE id=$1',
        [jobId],
      );
      expect(failedJob.rows[0]?.status).toBe('FAILED');
      const savedDeadLetter = await pool.query<{
        id: string;
        delivery_count: number;
        error_category: string;
      }>(
        `SELECT id,delivery_count,error_category FROM activity_work_dead_letter
         WHERE work_id=$1 AND work_type=$2 ORDER BY dead_lettered_at DESC LIMIT 1`,
        [jobId, statisticsWork.workType],
      );
      deadLetterId = savedDeadLetter.rows[0]?.id;
      if (!deadLetterId)
        throw new Error('terminal Activity dead letter was not persisted');
      expect(savedDeadLetter.rows[0]).toMatchObject({
        delivery_count: 8,
        error_category: 'Error',
      });
      await waitForConsumerAckPending(
        manager,
        registry.activityWorkStream,
        statisticsWork.durable,
        1,
      );

      const leaderInfo = await manager.streams.info(
        registry.activityWorkStream,
      );
      const failedLeader = leaderInfo.cluster?.leader;
      if (!failedLeader || !cluster.serverNames.includes(failedLeader))
        throw new Error('Activity work stream has no known leader');
      await cluster.stopNode(failedLeader);
      await waitFor(async () => {
        try {
          const info = await manager.streams.info(registry.activityWorkStream);
          return Boolean(
            info.cluster?.leader && info.cluster.leader !== failedLeader,
          );
        } catch {
          return false;
        }
      }, 'Activity work stream did not elect a leader for terminal settlement');

      releaseCommittedFailure();
      releaseSettlement = undefined;
      await terminalSettlement;
      await waitForConsumerAckPending(
        manager,
        registry.activityWorkStream,
        statisticsWork.durable,
        0,
      );
      const retainedDeadLetter = await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM activity_work_dead_letter WHERE id=$1',
        [deadLetterId],
      );
      expect(retainedDeadLetter.rows[0]?.count).toBe(1);
    } finally {
      releaseSettlement?.();
      await terminalSettlement?.catch(() => undefined);
      await publisher?.drain().catch(() => undefined);
      await cluster?.stopAll();
      await pool
        .query('DELETE FROM activity_work_dead_letter WHERE work_id=$1', [
          jobId,
        ])
        .catch(() => undefined);
      await pool
        .query('DELETE FROM activity_job WHERE id=$1', [jobId])
        .catch(() => undefined);
      await pool.end().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});

async function verifyTerminalFailureProcessRecovery() {
  const databaseUrl = process.env.ACTIVITY_DATABASE_URL;
  if (!databaseUrl) throw new Error('ACTIVITY_DATABASE_URL is required');
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname)
  )
    throw new Error('terminal process recovery requires local Postgres');

  const pool = new Pool({ connectionString: databaseUrl, max: 3 });
  const directory = await mkdtemp(
    join(tmpdir(), 'myota-activity-terminal-process-recovery-'),
  );
  const jobId = randomUUID();
  const programmeSlug = `terminal-process-${jobId}`;
  const port = await reserveLocalPort();
  const natsUrl = `nats://127.0.0.1:${port}`;
  const previousNatsUrl = process.env.NATS_URL;
  let server: ReturnType<typeof spawn> | undefined;
  let publisher: Awaited<ReturnType<typeof connect>> | undefined;
  let interrupted: (ChildProcess & { getOutput(): string }) | undefined;

  try {
    server = await startJetStream(port, directory);
    process.env.NATS_URL = natsUrl;
    publisher = await connect({
      servers: natsUrl,
      name: 'activity-terminal-process-recovery-publisher',
      maxReconnectAttempts: -1,
      reconnectTimeWait: 100,
    });
    const registry = await loadOutboxRegistry();
    const statisticsWork = registry.work.find(
      (work) => work.workType === 'activity.statistics-rebuild.v1',
    );
    if (!statisticsWork)
      throw new Error('statistics rebuild work is not registered');

    const manager = await jetstreamManager(publisher);
    await addTestStreamWithPlacementRetry(manager, {
      name: registry.activityWorkStream,
      subjects: [`${registry.activityWorkSubjectPrefix}>`],
      retention: RetentionPolicy.Workqueue,
      storage: StorageType.File,
      num_replicas: 1,
      max_age: 3_600_000_000_000,
      max_bytes: 16 * 1024 * 1024,
      max_msgs: 100,
      max_msg_size: 1024 * 1024,
    } as StreamConfig);
    await manager.consumers.add(registry.activityWorkStream, {
      durable_name: statisticsWork.durable,
      filter_subject: statisticsWork.subject,
      deliver_policy: DeliverPolicy.All,
      ack_policy: AckPolicy.Explicit,
      ack_wait: 2_000_000_000,
      max_deliver: 8,
      max_ack_pending: 1,
      max_waiting: 1,
      replay_policy: ReplayPolicy.Instant,
      num_replicas: 0,
    } as ConsumerConfig);

    await queueStatisticsJob(pool, jobId, programmeSlug);
    await publishWork(publisher, registry, jobId);
    interrupted = spawnTerminalPersistenceWorker({
      ...process.env,
      ACTIVITY_DATABASE_URL: databaseUrl,
      NATS_URL: natsUrl,
      MYOTA_ACTIVITY_WORKER_RECOVERY_TEST: '1',
      MYOTA_ACTIVITY_TERMINAL_RECOVERY_PHASE: 'persist',
    });
    await waitFor(
      async () => {
        if (interrupted?.exitCode !== null || interrupted?.signalCode !== null)
          throw new Error(
            `terminal persistence worker exited early: ${interrupted.getOutput()}`,
          );
        const job = await pool.query<{ status: string }>(
          'SELECT status FROM activity_job WHERE id=$1',
          [jobId],
        );
        const deadLetter = await pool.query(
          'SELECT 1 FROM activity_work_dead_letter WHERE work_id=$1',
          [jobId],
        );
        const consumerState = await manager.consumers.info(
          registry.activityWorkStream,
          statisticsWork.durable,
        );
        return (
          job.rows[0]?.status === 'FAILED' &&
          deadLetter.rowCount === 1 &&
          consumerState.num_ack_pending === 1
        );
      },
      'terminal Activity failure was not durable before the worker stopped',
      30_000,
    );

    interrupted.kill('SIGKILL');
    await waitForProcessExit(interrupted);
    const consumer = await jetstream(publisher).consumers.get(
      registry.activityWorkStream,
      statisticsWork.durable,
    );
    const redelivery = await consumer.next({ expires: 15_000 });
    if (!redelivery)
      throw new Error('JetStream did not redeliver unsettled terminal work');

    const repository = new ActivityWorkRepository(pool);
    const service = new ActivityWorkerService(
      repository,
      {} as ActivityRetentionRepository,
      pool,
    );
    const handler = service as unknown as {
      handle(
        definition: {
          kind: string;
          workType: string;
          subject: string;
          durable: string;
        },
        message: JsMsg,
      ): Promise<void>;
    };
    await handler.handle(
      {
        kind: 'STATISTICS_REBUILD',
        workType: statisticsWork.workType,
        subject: statisticsWork.subject,
        durable: statisticsWork.durable,
      },
      redelivery,
    );
    await waitForConsumerAckPending(
      manager,
      registry.activityWorkStream,
      statisticsWork.durable,
      0,
    );

    const finalJob = await pool.query<{ status: string }>(
      'SELECT status FROM activity_job WHERE id=$1',
      [jobId],
    );
    const finalDeadLetters = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM activity_work_dead_letter WHERE work_id=$1',
      [jobId],
    );
    expect(finalJob.rows[0]?.status).toBe('FAILED');
    expect(finalDeadLetters.rows[0]?.count).toBe(1);
  } finally {
    if (interrupted && interrupted.exitCode === null) {
      interrupted.kill('SIGKILL');
      await waitForProcessExit(interrupted).catch(() => undefined);
    }
    await publisher?.drain().catch(() => undefined);
    if (server) await stopJetStream(server);
    await pool
      .query('DELETE FROM activity_work_dead_letter WHERE work_id=$1', [jobId])
      .catch(() => undefined);
    await pool
      .query('DELETE FROM activity_job WHERE id=$1', [jobId])
      .catch(() => undefined);
    await pool.end().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    if (previousNatsUrl === undefined) delete process.env.NATS_URL;
    else process.env.NATS_URL = previousNatsUrl;
  }
}

async function persistTerminalFailureInChild() {
  const databaseUrl = process.env.ACTIVITY_DATABASE_URL;
  const natsUrl = process.env.NATS_URL;
  if (!databaseUrl || !natsUrl)
    throw new Error('terminal recovery child is missing database or broker');
  const registry = await loadOutboxRegistry();
  const statisticsWork = registry.work.find(
    (work) => work.workType === 'activity.statistics-rebuild.v1',
  );
  if (!statisticsWork)
    throw new Error('statistics rebuild work is not registered');
  const publisher = await connect({
    servers: natsUrl,
    name: 'activity-terminal-persistence-child',
    maxReconnectAttempts: -1,
    reconnectTimeWait: 100,
  });
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const consumer = await jetstream(publisher).consumers.get(
      registry.activityWorkStream,
      statisticsWork.durable,
    );
    const brokerMessage = await consumer.next({ expires: 10_000 });
    if (!brokerMessage)
      throw new Error('terminal recovery child received no work message');
    const repository = new ActivityWorkRepository(pool);
    repository.process = async () => {
      throw new Error('injected terminal processing failure');
    };
    const persistFailure = repository.failWorkJob.bind(repository);
    repository.failWorkJob = async (...args) => {
      await persistFailure(...args);
      await new Promise<void>(() => setInterval(() => undefined, 1000));
    };
    const service = new ActivityWorkerService(
      repository,
      {} as ActivityRetentionRepository,
      pool,
    );
    const handler = service as unknown as {
      handle(
        definition: {
          kind: string;
          workType: string;
          subject: string;
          durable: string;
        },
        message: JsMsg,
      ): Promise<void>;
    };
    const terminalMessage = {
      subject: brokerMessage.subject,
      data: brokerMessage.data,
      info: { ...brokerMessage.info, deliveryCount: 8 },
      working: () => brokerMessage.working(),
      ackAck: () => brokerMessage.ackAck(),
      nak: (milliseconds?: number) => brokerMessage.nak(milliseconds),
      term: () => brokerMessage.term(),
    } as unknown as JsMsg;
    await handler.handle(
      {
        kind: 'STATISTICS_REBUILD',
        workType: statisticsWork.workType,
        subject: statisticsWork.subject,
        durable: statisticsWork.durable,
      },
      terminalMessage,
    );
  } finally {
    await publisher.drain().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

function spawnTerminalPersistenceWorker(environment: NodeJS.ProcessEnv) {
  const child = spawn(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      'apps/activity-worker/src/activity-worker.restart-recovery.spec.ts',
      '-t',
      'settles terminal dead-letter redelivery after process loss before ACK',
      '--maxWorkers=1',
      '--no-file-parallelism',
    ],
    { env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
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

async function waitForProcessExit(child: ChildProcess, timeoutMs = 15_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('terminal recovery child did not exit')),
      timeoutMs,
    );
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function queueStatisticsJob(
  pool: Pool,
  id: string,
  programmeSlug: string,
) {
  await pool.query(
    `INSERT INTO activity_job(id,kind,payload)
     VALUES ($1,'STATISTICS_REBUILD',$2::jsonb)`,
    [id, JSON.stringify({ programmeSlug })],
  );
}

async function publishWork(
  publisher: Awaited<ReturnType<typeof connect>>,
  registry: Awaited<ReturnType<typeof loadOutboxRegistry>>,
  jobId: string,
) {
  const eventId = randomUUID();
  const routed = routeOutboxEvent(
    {
      eventId,
      eventType: 'activity.statistics-rebuild.v1',
      producer: 'activity-service',
      aggregateType: 'activity_job',
      aggregateId: jobId,
      payload: { jobId },
      occurredAt: new Date(),
      attempts: 1,
      correlationId: null,
    },
    registry,
    'activity',
  );
  await jetstream(publisher).publish(
    routed.subject,
    new TextEncoder().encode(JSON.stringify(routed.envelope)),
  );
}

async function waitForJob(pool: Pool, id: string, timeoutMs = 15_000) {
  await waitFor(
    async () => {
      const result = await pool.query<{ status: string }>(
        'SELECT status FROM activity_job WHERE id=$1',
        [id],
      );
      return result.rows[0]?.status === 'SUCCEEDED';
    },
    `Activity worker did not complete ${id}`,
    timeoutMs,
  );
}

async function waitForQueuedJob(pool: Pool, id: string, attempts: number) {
  await waitFor(async () => {
    const result = await pool.query<{
      status: string;
      attempts: number;
    }>('SELECT status,attempts FROM activity_job WHERE id=$1', [id]);
    return (
      result.rows[0]?.status === 'QUEUED' &&
      result.rows[0]?.attempts === attempts
    );
  }, `Activity worker did not persist a queued retry for ${id}`);
}

async function waitForConsumerAckPending(
  manager: Awaited<ReturnType<typeof jetstreamManager>>,
  stream: string,
  durable: string,
  expected: number,
) {
  await waitFor(async () => {
    const consumer = await manager.consumers.info(stream, durable);
    return consumer.num_ack_pending === expected;
  }, `Activity durable ${durable} did not release pending deliveries`);
}

async function provisionActivityWorkStream(
  manager: Awaited<ReturnType<typeof jetstreamManager>>,
  registry: Awaited<ReturnType<typeof loadOutboxRegistry>>,
  activityWork: Awaited<ReturnType<typeof loadOutboxRegistry>>['work'],
) {
  await addTestStreamWithPlacementRetry(manager, {
    name: registry.activityWorkStream,
    subjects: [`${registry.activityWorkSubjectPrefix}>`],
    retention: RetentionPolicy.Workqueue,
    storage: StorageType.File,
    num_replicas: 3,
    max_age: 3_600_000_000_000,
    max_bytes: 16 * 1024 * 1024,
    max_msgs: 1000,
    max_msg_size: 1024 * 1024,
  } as StreamConfig);
  for (const item of activityWork) {
    const [maxAckPending, maxWaiting] = activityConsumerLimits(item.durable);
    await manager.consumers.add(registry.activityWorkStream, {
      durable_name: item.durable,
      filter_subject: item.subject,
      deliver_policy: DeliverPolicy.All,
      ack_policy: AckPolicy.Explicit,
      replay_policy: ReplayPolicy.Instant,
      ack_wait: activityAckWait(item.durable) * 1_000_000_000,
      max_deliver: 8,
      max_ack_pending: maxAckPending,
      max_waiting: maxWaiting,
      num_replicas: 3,
    } as ConsumerConfig);
  }
  await waitFor(async () => {
    try {
      const info = await manager.streams.info(registry.activityWorkStream);
      return (info.cluster?.replicas?.length ?? 0) >= 2;
    } catch {
      return false;
    }
  }, 'Activity work stream did not replicate across all cluster nodes');
}

async function makeQueuedJobAvailable(pool: Pool, id: string) {
  const result = await pool.query(
    `UPDATE activity_job SET available_at=now()
     WHERE id=$1 AND status='QUEUED' RETURNING id`,
    [id],
  );
  if (!result.rowCount)
    throw new Error(`Activity retry ${id} was no longer queued`);
}

async function waitForPublisher(
  publisher: Awaited<ReturnType<typeof connect>>,
  stream: string,
) {
  await waitFor(async () => {
    try {
      await (await jetstreamManager(publisher)).streams.info(stream);
      return true;
    } catch {
      return false;
    }
  }, 'work publisher did not reconnect to JetStream');
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function startRetentionObjectStore(onFirstDelete: () => void) {
  const deletedKeys: string[] = [];
  const server = createHttpServer((request, response) => {
    request.resume();
    request.on('end', () => {
      if (request.method !== 'DELETE') {
        response.writeHead(405).end();
        return;
      }
      const key = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      deletedKeys.push(key);
      if (deletedKeys.length === 1) onFirstDelete();
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as import('node:net').AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    deletedKeys,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function reserveLocalPort() {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('could not reserve a local JetStream port'));
        return;
      }
      resolve(address.port);
    });
  });
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function startJetStream(port: number, storeDirectory: string) {
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
      throw new Error(`JetStream server exited during startup: ${output}`);
    if (output.includes('Server is ready')) return server;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  server.kill('SIGKILL');
  throw new Error(`JetStream server did not start: ${output}`);
}

async function stopJetStream(server: ReturnType<typeof spawn>) {
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

function activityConsumerLimits(durable: string): [number, number] {
  const limits: Record<string, [number, number]> = {
    'activity-qso-ingestion-v1': [4, 4],
    'activity-adif-import-v1': [1, 1],
    'activity-award-recalculate-v1': [2, 2],
    'activity-award-evaluation-v1': [2, 2],
    'activity-pdf-render-v1': [1, 1],
    'activity-statistics-rebuild-v1': [1, 1],
  };
  const policy = limits[durable];
  if (!policy) throw new Error(`No Activity consumer policy for ${durable}`);
  return policy;
}

function activityAckWait(durable: string) {
  return durable.includes('adif') ||
    durable.includes('pdf') ||
    durable.includes('statistics')
    ? 300
    : 120;
}
