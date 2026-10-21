import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
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

type ActivityNotificationServiceClass =
  typeof import('./activity-notifications.service.js').ActivityNotificationsService;
type ActivityNotificationService =
  InstanceType<ActivityNotificationServiceClass>;

const STREAM = 'MYOTA_EVENTS';
const DURABLE = 'activity-notifications-v1';
const enabled = Boolean(
  process.env.NATS_TEST_URL && process.env.ACTIVITY_DATABASE_URL,
);

describe.skipIf(!enabled)('Activity notification JetStream recovery', () => {
  let pool: Pool;
  let ActivityNotificationsServiceClass: ActivityNotificationServiceClass;
  const services: ActivityNotificationService[] = [];

  beforeAll(async () => {
    process.env.NATS_URL = process.env.NATS_TEST_URL;
    process.env.ACTIVITY_NOTIFICATION_METRICS_PORT = '0';
    pool = new Pool({ connectionString: process.env.ACTIVITY_DATABASE_URL });

    const connection = await connect({
      servers: process.env.NATS_TEST_URL!,
      name: 'activity-notification-recovery-fixture',
    });
    try {
      const manager = await jetstreamManager(connection);
      // Fail rather than erase data if NATS_TEST_URL is not an isolated broker.
      await manager.streams.add({
        name: STREAM,
        subjects: ['myota.events.>'],
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        num_replicas: 1,
        max_age: 3_600_000_000_000,
        max_bytes: 16 * 1024 * 1024,
        max_msgs: 1000,
        max_msg_size: 1024 * 1024,
      } as StreamConfig);
      const { ACTIVITY_NOTIFICATION_SUBJECTS } =
        await import('./activity-notifications.service.js');
      await manager.consumers.add(STREAM, {
        durable_name: DURABLE,
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
    } finally {
      await connection.drain();
    }

    const notificationService =
      await import('./activity-notifications.service.js');
    ActivityNotificationsServiceClass =
      notificationService.ActivityNotificationsService;
  }, 30_000);

  afterAll(async () => {
    await Promise.allSettled(
      services.splice(0).map((service) => service.onModuleDestroy()),
    );
    await pool?.end();
  }, 30_000);

  it('shares the durable across replicas, resumes after restart, and redrives an audited dead letter', async () => {
    const publisher = await connect({
      servers: process.env.NATS_TEST_URL!,
      name: 'activity-notification-recovery-publisher',
    });
    const eventIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const recipient = randomUUID();
    const dedupeKeys = eventIds.map((eventId) => `event:${eventId}`);
    const createService = async () => {
      const service = new ActivityNotificationsServiceClass(pool);
      services.push(service);
      await service.onModuleInit();
      return service;
    };
    const publish = async (eventId: string) => {
      await jetstream(publisher).publish(
        'myota.events.identity.account.created.v1',
        new TextEncoder().encode(
          JSON.stringify({
            eventId,
            eventType: 'identity.account.created.v1',
            payload: { accountId: recipient },
          }),
        ),
      );
    };
    const waitForStoredNotifications = async (expected: number) => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const result = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM public.activity_notification
            WHERE recipient_id=$1 AND deduplication_key=ANY($2::text[])`,
          [recipient, dedupeKeys],
        );
        if (Number(result.rows[0]?.count ?? 0) === expected) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`expected ${expected} durable notifications`);
    };

    try {
      await Promise.all([createService(), createService()]);
      await Promise.all(eventIds.slice(0, 2).map(publish));
      await waitForStoredNotifications(2);

      const secondReplica = services[1]!;
      await secondReplica.onModuleDestroy();
      services.splice(services.indexOf(secondReplica), 1);
      const restarted = await createService();
      expect(restarted).toBeDefined();
      await publish(eventIds[2]!);
      await waitForStoredNotifications(3);

      const redrivenEventId = eventIds[3]!;
      const redrivenEnvelope = {
        eventId: redrivenEventId,
        eventType: 'identity.account.created.v1',
        payload: { accountId: recipient },
      };
      await pool.query(
        `INSERT INTO public.dead_letter_event
          (event_id,event_type,payload,attempts,error,stream_name,stream_sequence,subject)
         VALUES ($1,$2,$3::jsonb,8,'delivery_attempts_exhausted',$4,999999,$5)`,
        [
          redrivenEventId,
          redrivenEnvelope.eventType,
          JSON.stringify(redrivenEnvelope),
          STREAM,
          'myota.events.identity.account.created.v1',
        ],
      );
      const redrive = await new Promise<{ stdout: string; stderr: string }>(
        (resolveRedrive, rejectRedrive) => {
          const child = spawn(
            process.execPath,
            [
              '--experimental-strip-types',
              resolve(
                process.cwd(),
                'apps/activity-notifications/src/redrive-notification.ts',
              ),
              '--event-id',
              redrivenEventId,
              '--actor',
              'ci-recovery-test',
              '--reason',
              'verify audited notification recovery',
            ],
            { cwd: process.cwd(), env: process.env },
          );
          let stdout = '';
          let stderr = '';
          child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
            stdout += chunk;
          });
          child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
            stderr += chunk;
          });
          child.once('error', rejectRedrive);
          child.once('close', (code) => {
            if (code === 0) resolveRedrive({ stdout, stderr });
            else
              rejectRedrive(
                new Error(`notification redrive failed (${code}): ${stderr}`),
              );
          });
        },
      );
      expect(redrive.stdout).toContain(
        'published audited Activity notification redrive',
      );
      await waitForStoredNotifications(4);
      const deadline = Date.now() + 20_000;
      let redriveResolved = false;
      while (Date.now() < deadline && !redriveResolved) {
        const redriveState = await pool.query<{
          status: string;
          published_at: Date | null;
          resolved_at: Date | null;
        }>(
          `SELECT r.status,r.published_at,d.resolved_at
             FROM public.activity_notification_redrive r
             JOIN public.dead_letter_event d ON d.event_id=r.event_id
            WHERE r.event_id=$1`,
          [redrivenEventId],
        );
        redriveResolved =
          redriveState.rows[0]?.status === 'PUBLISHED' &&
          redriveState.rows[0].published_at !== null &&
          redriveState.rows[0].resolved_at !== null;
        if (!redriveResolved)
          await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
      }
      expect(redriveResolved).toBe(true);
    } finally {
      await Promise.allSettled(
        services.splice(0).map((service) => service.onModuleDestroy()),
      );
      await pool.query(
        'DELETE FROM public.activity_notification WHERE deduplication_key=ANY($1::text[])',
        [dedupeKeys],
      );
      await pool.query(
        'DELETE FROM public.activity_notification_redrive WHERE event_id=ANY($1::uuid[])',
        [eventIds],
      );
      await pool.query(
        'DELETE FROM public.dead_letter_event WHERE event_id=ANY($1::uuid[]) AND stream_name=$2',
        [eventIds, STREAM],
      );
      await pool.query(
        'DELETE FROM public.consumer_processed_event WHERE consumer=$1 AND event_id=ANY($2::uuid[])',
        [DURABLE.replace(/-v\d+$/, ''), eventIds],
      );
      await publisher.drain();
    }
  }, 30_000);
});
