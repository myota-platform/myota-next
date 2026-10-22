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
import type { ConsumerConfig, JsMsg, StreamConfig } from '@nats-io/jetstream';
import { connect } from '@nats-io/transport-node';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { DatabaseHealthService } from '../../../libs/platform/src/database.module.js';
import { startPostgresFaultProxy } from '../../../libs/platform/src/testing/postgres-fault-proxy.js';
import {
  addTestStreamWithPlacementRetry,
  startTestJetStreamCluster,
  type TestJetStreamCluster,
} from '../../../libs/platform/src/testing/jetstream-cluster.js';
import {
  ACTIVITY_NOTIFICATION_SUBJECTS,
  ActivityNotificationsService,
} from './activity-notifications.service.js';

const enabled =
  process.env.MYOTA_ACTIVITY_NOTIFICATION_RESTART_TEST === '1' &&
  Boolean(process.env.ACTIVITY_DATABASE_URL);
const streamName = 'MYOTA_EVENTS';
const durableName = 'activity-notifications-v1';
const consumerName = 'activity-notifications';
const subject = 'myota.events.identity.account.created.v1';

describe.skipIf(!enabled)('Activity notification broker restart', () => {
  it('reconnects to JetStream and resumes durable delivery after restart', async () => {
    const databaseUrl = process.env.ACTIVITY_DATABASE_URL;
    if (!databaseUrl) throw new Error('ACTIVITY_DATABASE_URL is required');
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(
        new URL(databaseUrl).hostname,
      )
    )
      throw new Error('broker restart recovery requires local Postgres');

    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: databaseUrl, max: 3 });
    const databaseProxy = await startPostgresFaultProxy(databaseUrl);
    const workerPool = new Pool({
      connectionString: databaseProxy.connectionString,
      max: 3,
      connectionTimeoutMillis: 1000,
    });
    const workerPoolHealth = new DatabaseHealthService(workerPool as Pool);
    const directory = await mkdtemp(join(tmpdir(), 'myota-notifications-'));
    const port = await reserveLocalPort();
    const natsUrl = `nats://127.0.0.1:${port}`;
    const ids = [randomUUID(), randomUUID()];
    const recipient = randomUUID();
    const dedupeKeys = ids.map((id) => `event:${id}`);
    const deadLetterStreamSequence = Number(BigInt(Date.now()) * 1000n);
    const originalNatsUrl = process.env.NATS_URL;
    let server: ReturnType<typeof spawn> | undefined;
    let publisher: Awaited<ReturnType<typeof connect>> | undefined;
    let service: ActivityNotificationsService | undefined;
    const priorCheckpoint = await pool.query<{
      last_event_id: string;
      updated_at: Date;
    }>(
      `SELECT last_event_id::text,updated_at FROM public.consumer_checkpoint
       WHERE consumer=$1`,
      [consumerName],
    );

    try {
      server = await startJetStream(port, directory);
      process.env.NATS_URL = natsUrl;
      publisher = await connect({
        servers: natsUrl,
        name: 'activity-notification-restart-publisher',
        maxReconnectAttempts: -1,
        reconnectTimeWait: 100,
      });
      const manager = await jetstreamManager(publisher);
      await manager.streams.add({
        name: streamName,
        subjects: ['myota.events.>'],
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        num_replicas: 1,
        max_age: 3_600_000_000_000,
        max_bytes: 16 * 1024 * 1024,
        max_msgs: 1000,
        max_msg_size: 1024 * 1024,
      } as StreamConfig);
      await manager.consumers.add(streamName, {
        durable_name: durableName,
        filter_subjects: ACTIVITY_NOTIFICATION_SUBJECTS,
        deliver_policy: DeliverPolicy.All,
        ack_policy: AckPolicy.Explicit,
        replay_policy: ReplayPolicy.Instant,
        ack_wait: 60_000_000_000,
        max_deliver: 8,
        max_ack_pending: 64,
        max_waiting: 32,
        backoff: [60, 120, 300, 300, 300, 300, 300].map(
          (seconds) => seconds * 1_000_000_000,
        ),
        num_replicas: 0,
      } as ConsumerConfig);

      service = new ActivityNotificationsService(workerPool as Pool);
      await service.onModuleInit();
      const serviceState = service as unknown as {
        natsUp: boolean;
        completedMessages: number;
      };
      await waitFor(() => serviceState.natsUp, 'consumer did not connect');
      await publish(publisher, ids[0]!, recipient);
      await waitForNotifications(pool, dedupeKeys, 1);
      await waitForDurableIdle(manager);

      await stopJetStream(server);
      server = undefined;
      await waitFor(
        () => !serviceState.natsUp,
        'consumer did not detect outage',
      );

      server = await startJetStream(port, directory);
      await waitFor(() => serviceState.natsUp, 'consumer did not reconnect');
      const restartedManager = await jetstreamManager(publisher);
      await restartedManager.streams.info(streamName);
      const internals = service as unknown as {
        processEvent: (
          event: { eventId?: unknown },
          eventType: string,
        ) => Promise<boolean>;
      };
      const processEvent = internals.processEvent.bind(service);
      let databaseOutageInjected = false;
      internals.processEvent = async (event, eventType) => {
        if (event.eventId === ids[1] && !databaseOutageInjected) {
          databaseOutageInjected = true;
          databaseProxy.setAvailable(false);
        }
        return await processEvent(event, eventType);
      };
      const rejectedBeforeOutage = databaseProxy.rejectedConnections();
      await publish(publisher, ids[1]!, recipient);
      await publish(publisher, ids[1]!, recipient);
      await waitFor(async () => {
        const state = await restartedManager.consumers.info(
          streamName,
          durableName,
        );
        return (
          databaseOutageInjected &&
          databaseProxy.rejectedConnections() > rejectedBeforeOutage &&
          state.num_ack_pending > 0
        );
      }, 'notification consumer did not retain the delivery during a PostgreSQL outage');
      const notificationsDuringOutage = await pool.query(
        'SELECT count(*)::int AS count FROM public.activity_notification WHERE deduplication_key=$1',
        [dedupeKeys[1]],
      );
      expect(notificationsDuringOutage.rows[0]?.count).toBe(0);
      databaseProxy.setAvailable(true);
      await waitForNotifications(pool, dedupeKeys, 2);
      await waitFor(
        () => serviceState.completedMessages === 3,
        `notification consumer completed ${serviceState.completedMessages} of 3 deliveries`,
      );

      const processed = await pool.query(
        `SELECT count(*)::int AS count FROM public.consumer_processed_event
         WHERE consumer=$1 AND event_id=ANY($2::uuid[])`,
        [consumerName, ids],
      );
      expect(processed.rows[0]?.count).toBe(2);

      let injectedDeadLetterOutage = false;
      let deliveryTerminated = false;
      const terminalInternals = service as unknown as {
        handle(message: JsMsg): Promise<void>;
        persistDeadLetter(
          message: JsMsg,
          event: Record<string, unknown>,
          eventType: string,
          attempts: number,
          permanent: boolean,
        ): Promise<void>;
      };
      const persistDeadLetter =
        terminalInternals.persistDeadLetter.bind(service);
      terminalInternals.persistDeadLetter = async (...args) => {
        if (!injectedDeadLetterOutage) {
          injectedDeadLetterOutage = true;
          databaseProxy.setAvailable(false);
        }
        return persistDeadLetter(...args);
      };
      const rejectedBeforeDeadLetter = databaseProxy.rejectedConnections();
      const terminalDelivery = {
        info: {
          deliveryCount: 8,
          streamSequence: deadLetterStreamSequence,
        },
        subject,
        data: new TextEncoder().encode(
          JSON.stringify({
            eventId: 'malformed-event-id',
            eventType: 'identity.account.created.v1',
            payload: { accountId: recipient },
          }),
        ),
        working: () => undefined,
        term: () => {
          deliveryTerminated = true;
        },
        nak: () => {
          throw new Error('exhausted delivery must be terminated');
        },
      } as unknown as JsMsg;
      const persistTerminalDelivery = internals.handle.bind(service);
      const terminalResult = persistTerminalDelivery(terminalDelivery);
      await waitFor(
        () =>
          injectedDeadLetterOutage &&
          databaseProxy.rejectedConnections() > rejectedBeforeDeadLetter &&
          !deliveryTerminated,
        'notification delivery was terminated before dead-letter persistence recovered',
      );
      const missingDeadLetter = await pool.query(
        `SELECT 1 FROM public.dead_letter_event
         WHERE stream_name=$1 AND stream_sequence=$2`,
        [streamName, deadLetterStreamSequence],
      );
      expect(missingDeadLetter.rowCount).toBe(0);
      databaseProxy.setAvailable(true);
      await terminalResult;
      expect(deliveryTerminated).toBe(true);
      terminalInternals.persistDeadLetter = persistDeadLetter;
      const savedDeadLetter = await pool.query<{
        attempts: number;
        error: string;
        event_type: string;
      }>(
        `SELECT attempts,error,event_type FROM public.dead_letter_event
         WHERE stream_name=$1 AND stream_sequence=$2`,
        [streamName, deadLetterStreamSequence],
      );
      expect(savedDeadLetter.rows[0]).toEqual({
        attempts: 8,
        error: 'invalid_or_unsupported_envelope',
        event_type: 'identity.account.created.v1',
      });
    } finally {
      databaseProxy.setAvailable(true);
      if (service) await service.onModuleDestroy().catch(() => undefined);
      await workerPoolHealth.onModuleDestroy().catch(() => undefined);
      if (publisher) await publisher.drain().catch(() => undefined);
      if (server) await stopJetStream(server).catch(() => undefined);
      await cleanupFixture(
        pool,
        ids,
        dedupeKeys,
        priorCheckpoint.rows[0],
        deadLetterStreamSequence,
      );
      await pool.end();
      await databaseProxy.close();
      await rm(directory, { recursive: true, force: true });
      if (originalNatsUrl === undefined) delete process.env.NATS_URL;
      else process.env.NATS_URL = originalNatsUrl;
    }
  }, 45_000);

  it('continues a pending delivery after JetStream leader failover', async () => {
    const databaseUrl = process.env.ACTIVITY_DATABASE_URL;
    if (!databaseUrl) throw new Error('ACTIVITY_DATABASE_URL is required');
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(
        new URL(databaseUrl).hostname,
      )
    )
      throw new Error('cluster failover recovery requires local Postgres');

    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: databaseUrl, max: 3 });
    const databaseProxy = await startPostgresFaultProxy(databaseUrl);
    const workerPool = new Pool({
      connectionString: databaseProxy.connectionString,
      max: 3,
      connectionTimeoutMillis: 1000,
    });
    const workerPoolHealth = new DatabaseHealthService(workerPool as Pool);
    const directory = await mkdtemp(
      join(tmpdir(), 'myota-notifications-cluster-'),
    );
    const ids = [randomUUID()];
    const terminalEventId = randomUUID();
    const recipient = randomUUID();
    const dedupeKeys = ids.map((id) => `event:${id}`);
    const originalNatsUrl = process.env.NATS_URL;
    let deadLetterStreamSequence = Number(BigInt(Date.now()) * 1000n);
    let cluster: TestJetStreamCluster | undefined;
    let publisher: Awaited<ReturnType<typeof connect>> | undefined;
    let service: ActivityNotificationsService | undefined;
    const priorCheckpoint = await pool.query<{
      last_event_id: string;
      updated_at: Date;
    }>(
      `SELECT last_event_id::text,updated_at FROM public.consumer_checkpoint
       WHERE consumer=$1`,
      [consumerName],
    );

    try {
      cluster = await startTestJetStreamCluster(
        directory,
        'myota-notification-recovery',
        'notification-cluster',
      );
      process.env.NATS_URL = cluster.natsUrl;
      publisher = await connect({
        servers: cluster.natsUrl,
        name: 'activity-notification-cluster-publisher',
        maxReconnectAttempts: -1,
        reconnectTimeWait: 100,
      });
      const manager = await jetstreamManager(publisher);
      await addTestStreamWithPlacementRetry(manager, {
        name: streamName,
        subjects: ['myota.events.>'],
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        num_replicas: 3,
        max_age: 3_600_000_000_000,
        max_bytes: 16 * 1024 * 1024,
        max_msgs: 1000,
        max_msg_size: 1024 * 1024,
      } as StreamConfig);
      await manager.consumers.add(streamName, {
        durable_name: durableName,
        filter_subjects: ACTIVITY_NOTIFICATION_SUBJECTS,
        deliver_policy: DeliverPolicy.All,
        ack_policy: AckPolicy.Explicit,
        replay_policy: ReplayPolicy.Instant,
        ack_wait: 60_000_000_000,
        max_deliver: 8,
        max_ack_pending: 64,
        max_waiting: 32,
        backoff: [60, 120, 300, 300, 300, 300, 300].map(
          (seconds) => seconds * 1_000_000_000,
        ),
        num_replicas: 3,
      } as ConsumerConfig);
      await waitFor(async () => {
        try {
          const info = await manager.streams.info(streamName);
          return (info.cluster?.replicas?.length ?? 0) >= 2;
        } catch {
          return false;
        }
      }, 'JetStream stream did not replicate across all cluster nodes');

      service = new ActivityNotificationsService(workerPool as Pool);
      await service.onModuleInit();
      const serviceState = service as unknown as {
        natsUp: boolean;
        handle(message: JsMsg): Promise<void>;
        persistDeadLetter(
          message: JsMsg,
          event: Record<string, unknown>,
          eventType: string,
          attempts: number,
          permanent: boolean,
        ): Promise<void>;
        processEvent: (
          event: { eventId?: unknown },
          eventType: string,
        ) => Promise<boolean>;
      };
      await waitFor(() => serviceState.natsUp, 'consumer did not connect');
      const processEvent = serviceState.processEvent.bind(service);
      serviceState.processEvent = async (event, eventType) => {
        if (event.eventId === terminalEventId)
          throw new Error('injected terminal notification failure');
        return processEvent(event, eventType);
      };
      const persistDeadLetter = serviceState.persistDeadLetter.bind(service);
      serviceState.persistDeadLetter = async (...args) => {
        if (args[1].eventId === terminalEventId)
          databaseProxy.setAvailable(false);
        return persistDeadLetter(...args);
      };
      const handle = serviceState.handle.bind(service);
      serviceState.handle = async (message) => {
        const envelope = JSON.parse(new TextDecoder().decode(message.data)) as {
          eventId?: string;
        };
        if (envelope.eventId !== terminalEventId) return handle(message);
        const terminalMessage = new Proxy(message, {
          get(target, property) {
            if (property === 'info')
              return { ...target.info, deliveryCount: 8 };
            const value = Reflect.get(target, property) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        await handle(terminalMessage);
      };

      const rejectedBeforeDeadLetter = databaseProxy.rejectedConnections();
      const terminalPublish = await jetstream(publisher).publish(
        subject,
        new TextEncoder().encode(
          JSON.stringify({
            eventId: terminalEventId,
            eventType: 'identity.account.created.v1',
            payload: { accountId: recipient },
          }),
        ),
      );
      deadLetterStreamSequence = terminalPublish.seq;
      await waitFor(async () => {
        try {
          const info = await manager.consumers.info(streamName, durableName);
          return (
            databaseProxy.rejectedConnections() > rejectedBeforeDeadLetter &&
            info.num_ack_pending > 0
          );
        } catch {
          return false;
        }
      }, 'terminal notification delivery did not remain pending during PostgreSQL outage');
      const deadLetterDuringOutage = await pool.query(
        `SELECT 1 FROM public.dead_letter_event
         WHERE stream_name=$1 AND stream_sequence=$2`,
        [streamName, deadLetterStreamSequence],
      );
      expect(deadLetterDuringOutage.rowCount).toBe(0);
      const consumerBeforeFailover = await manager.consumers.info(
        streamName,
        durableName,
      );
      expect(consumerBeforeFailover.num_ack_pending).toBeGreaterThan(0);
      const leaderBeforeTerminalFailover = (
        await manager.streams.info(streamName)
      ).cluster?.leader;
      if (!leaderBeforeTerminalFailover)
        throw new Error('JetStream stream has no elected leader');
      if (!cluster.serverNames.includes(leaderBeforeTerminalFailover))
        throw new Error(
          `JetStream elected an unknown leader: ${leaderBeforeTerminalFailover}`,
        );
      await cluster.stopNode(leaderBeforeTerminalFailover);
      await waitFor(async () => {
        try {
          const info = await manager.streams.info(streamName);
          return Boolean(
            info.cluster?.leader &&
            info.cluster.leader !== leaderBeforeTerminalFailover,
          );
        } catch {
          return false;
        }
      }, 'JetStream cluster did not elect a leader during terminal settlement');
      databaseProxy.setAvailable(true);
      await waitForDurableIdle(manager);
      const terminalDeadLetter = await pool.query<{
        attempts: number;
        error: string;
      }>(
        `SELECT attempts,error FROM public.dead_letter_event
         WHERE stream_name=$1 AND stream_sequence=$2`,
        [streamName, deadLetterStreamSequence],
      );
      expect(terminalDeadLetter.rows[0]).toEqual({
        attempts: 8,
        error: 'delivery_attempts_exhausted',
      });

      await publish(publisher, ids[0]!, recipient);
      await publish(publisher, ids[0]!, recipient);
      await waitForNotifications(pool, dedupeKeys, 1);
      await waitForDurableIdle(manager);
      const processed = await pool.query(
        `SELECT count(*)::int AS count FROM public.consumer_processed_event
         WHERE consumer=$1 AND event_id=$2`,
        [consumerName, ids[0]],
      );
      expect(processed.rows[0]?.count).toBe(1);
      const notificationCount = await pool.query(
        `SELECT count(*)::int AS count FROM public.activity_notification
         WHERE deduplication_key=$1`,
        [dedupeKeys[0]],
      );
      expect(notificationCount.rows[0]?.count).toBe(1);
    } finally {
      databaseProxy.setAvailable(true);
      if (service) await service.onModuleDestroy().catch(() => undefined);
      await workerPoolHealth.onModuleDestroy().catch(() => undefined);
      if (publisher) await publisher.drain().catch(() => undefined);
      await cluster?.stopAll();
      await cleanupFixture(
        pool,
        ids,
        dedupeKeys,
        priorCheckpoint.rows[0],
        deadLetterStreamSequence,
      );
      await pool.end();
      await databaseProxy.close();
      await rm(directory, { recursive: true, force: true });
      if (originalNatsUrl === undefined) delete process.env.NATS_URL;
      else process.env.NATS_URL = originalNatsUrl;
    }
  }, 60_000);
});

async function publish(
  publisher: Awaited<ReturnType<typeof connect>>,
  eventId: string,
  accountId: string,
) {
  await jetstream(publisher).publish(
    subject,
    new TextEncoder().encode(
      JSON.stringify({
        eventId,
        eventType: 'identity.account.created.v1',
        payload: { accountId },
      }),
    ),
  );
}

async function waitForNotifications(
  pool: Pool,
  dedupeKeys: string[],
  expected: number,
) {
  await waitFor(async () => {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.activity_notification
       WHERE deduplication_key=ANY($1::text[])`,
      [dedupeKeys],
    );
    return Number(result.rows[0]?.count ?? 0) === expected;
  }, `expected ${expected} stored notifications`);
}

async function waitForDurableIdle(
  manager: Awaited<ReturnType<typeof jetstreamManager>>,
) {
  let lastInfo: Awaited<ReturnType<typeof manager.consumers.info>> | undefined;
  try {
    await waitFor(
      async () => {
        try {
          lastInfo = await manager.consumers.info(streamName, durableName);
          return lastInfo.num_pending === 0 && lastInfo.num_ack_pending === 0;
        } catch {
          return false;
        }
      },
      'notification durable did not settle after restart',
      30_000,
    );
  } catch (error) {
    const state = lastInfo
      ? {
          numPending: lastInfo.num_pending,
          numAckPending: lastInfo.num_ack_pending,
          delivered: lastInfo.delivered,
          ackFloor: lastInfo.ack_floor,
        }
      : 'consumer info unavailable';
    throw new Error(
      `${String(error)}; consumer state: ${JSON.stringify(state)}`,
    );
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
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
    throw new Error('could not reserve a local JetStream port');
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
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

async function cleanupFixture(
  pool: Pool,
  eventIds: string[],
  dedupeKeys: string[],
  priorCheckpoint: { last_event_id: string; updated_at: Date } | undefined,
  deadLetterStreamSequence: number,
) {
  try {
    await pool.query(
      'DELETE FROM public.dead_letter_event WHERE stream_name=$1 AND stream_sequence=$2',
      [streamName, deadLetterStreamSequence],
    );
    await pool.query(
      'DELETE FROM public.activity_notification WHERE deduplication_key=ANY($1::text[])',
      [dedupeKeys],
    );
    await pool.query(
      'DELETE FROM public.consumer_processed_event WHERE consumer=$1 AND event_id=ANY($2::uuid[])',
      [consumerName, eventIds],
    );
    if (priorCheckpoint) {
      await pool.query(
        `UPDATE public.consumer_checkpoint SET last_event_id=$2,updated_at=$3
         WHERE consumer=$1`,
        [
          consumerName,
          priorCheckpoint.last_event_id,
          priorCheckpoint.updated_at,
        ],
      );
    } else {
      await pool.query(
        'DELETE FROM public.consumer_checkpoint WHERE consumer=$1',
        [consumerName],
      );
    }
  } catch (error) {
    throw new Error(
      `could not clean notification recovery fixture: ${String(error)}`,
    );
  }
}
