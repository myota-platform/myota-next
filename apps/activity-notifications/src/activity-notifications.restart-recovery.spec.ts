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
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
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
    const directory = await mkdtemp(join(tmpdir(), 'myota-notifications-'));
    const port = await reserveLocalPort();
    const natsUrl = `nats://127.0.0.1:${port}`;
    const ids = [randomUUID(), randomUUID()];
    const recipient = randomUUID();
    const dedupeKeys = ids.map((id) => `event:${id}`);
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

      service = new ActivityNotificationsService(pool as Pool);
      await service.onModuleInit();
      const serviceState = service as unknown as { natsUp: boolean };
      await waitFor(() => serviceState.natsUp, 'consumer did not connect');
      await publish(publisher, ids[0]!, recipient);
      await waitForNotifications(pool, dedupeKeys, 1);

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
      await publish(publisher, ids[1]!, recipient);
      await publish(publisher, ids[1]!, recipient);
      await waitForNotifications(pool, dedupeKeys, 2);
      await waitForDurableIdle(restartedManager);

      const processed = await pool.query(
        `SELECT count(*)::int AS count FROM public.consumer_processed_event
         WHERE consumer=$1 AND event_id=ANY($2::uuid[])`,
        [consumerName, ids],
      );
      expect(processed.rows[0]?.count).toBe(2);
    } finally {
      if (service) await service.onModuleDestroy().catch(() => undefined);
      if (publisher) await publisher.drain().catch(() => undefined);
      if (server) await stopJetStream(server).catch(() => undefined);
      await cleanupFixture(pool, ids, dedupeKeys, priorCheckpoint.rows[0]);
      await pool.end();
      await rm(directory, { recursive: true, force: true });
    }
  }, 45_000);
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
  await waitFor(async () => {
    const consumer = await manager.consumers.info(streamName, durableName);
    return consumer.num_pending === 0 && consumer.num_ack_pending === 0;
  }, 'notification durable did not settle after restart');
}

async function waitFor(
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
) {
  try {
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
