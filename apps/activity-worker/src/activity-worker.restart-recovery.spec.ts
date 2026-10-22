import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
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
import type { ConsumerConfig, StreamConfig } from '@nats-io/jetstream';
import { connect } from '@nats-io/transport-node';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { DatabaseHealthService } from '../../../libs/platform/src/database.module.js';
import { startPostgresFaultProxy } from '../../../libs/platform/src/testing/postgres-fault-proxy.js';
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
    const jobs = [randomUUID(), randomUUID(), randomUUID()];
    const programmeSlugs = jobs.map((id) => `worker-restart-${id}`);
    let server: ReturnType<typeof spawn> | undefined;
    let publisher: Awaited<ReturnType<typeof connect>> | undefined;
    let worker: ActivityWorkerService | undefined;

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
      workRepository.process = async (job) => {
        if (job.id === jobs[1] && injectSettlementFailure) {
          injectSettlementFailure = false;
          databaseProxy.setAvailable(false);
          throw new Error('injected failure before retry-state persistence');
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
      await waitFor(async () => {
        const result = await pool.query<{
          status: string;
          attempts: number;
        }>('SELECT status,attempts FROM activity_job WHERE id=$1', [jobs[1]]);
        return (
          result.rows[0]?.status === 'QUEUED' && result.rows[0]?.attempts === 1
        );
      }, 'Activity worker did not persist retry state after PostgreSQL recovered');
      // The retained original delivery is NAKed after retry state commits and
      // should drive the queued retry itself.
      await waitForJob(pool, jobs[1]!, 30_000);

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
    } finally {
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
        .query('DELETE FROM activity_job WHERE id=ANY($1::uuid[])', [jobs])
        .catch(() => undefined);
      await pool.end();
      await databaseProxy.close();
      await rm(directory, { recursive: true, force: true });
      if (originalNatsUrl === undefined) delete process.env.NATS_URL;
      else process.env.NATS_URL = originalNatsUrl;
    }
  }, 60_000);
});

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
