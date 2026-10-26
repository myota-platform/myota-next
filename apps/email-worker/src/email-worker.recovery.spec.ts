import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
import { addTestStreamWithPlacementRetry } from '../../../libs/platform/src/testing/jetstream-cluster.js';
import { EmailWorkerService } from './email-worker.service.js';

const enabled =
  process.env.MYOTA_EMAIL_WORKER_RECOVERY_TEST === '1' &&
  Boolean(process.env.CORE_DATABASE_URL);
const stream = 'MYOTA_EMAIL_WORK';
const durable = 'email-delivery-v1';
const subject = 'myota.work.email.send.v1';

describe.skipIf(!enabled)('Email worker JetStream recovery', () => {
  it('persists retry exhaustion before terminating the eighth delivery', async () => {
    const databaseUrl = process.env.CORE_DATABASE_URL;
    if (!databaseUrl) throw new Error('CORE_DATABASE_URL is required');
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(
        new URL(databaseUrl).hostname,
      )
    )
      throw new Error('Email recovery qualification requires local Postgres');

    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const directory = await mkdtemp(join(tmpdir(), 'myota-email-recovery-'));
    const port = await reserveLocalPort();
    const natsUrl = `nats://127.0.0.1:${port}`;
    const workId = randomUUID();
    const environmentNames = [
      'NATS_URL',
      'EMAIL_SMTP_HOST',
      'EMAIL_SMTP_PORT',
      'EMAIL_SMTP_USERNAME',
      'EMAIL_SMTP_PASSWORD',
      'EMAIL_SMTP_PASSWORD_FILE',
      'EMAIL_SMTP_TLS_MODE',
      'EMAIL_SMTP_TIMEOUT_SECONDS',
      'EMAIL_SENDER_ADDRESS',
      'EMAIL_SENDER_DISPLAY_NAME',
      'MYOTA_EMAIL_SERVICE_CLIENT_SECRET',
      'MYOTA_EMAIL_SERVICE_CLIENT_SECRET_FILE',
      'MYOTA_IDENTITY_URL',
    ] as const;
    const previousEnvironment = new Map(
      environmentNames.map((name) => [name, process.env[name]]),
    );
    let server: ReturnType<typeof spawn> | undefined;
    let publisher: Awaited<ReturnType<typeof connect>> | undefined;
    let smtpAttempts = 0;
    let smtpAvailable = false;

    try {
      process.env.NATS_URL = natsUrl;
      process.env.EMAIL_SMTP_HOST = '127.0.0.1';
      process.env.EMAIL_SMTP_PORT = '587';
      process.env.EMAIL_SMTP_USERNAME = 'recovery-test';
      process.env.EMAIL_SMTP_PASSWORD = 'recovery-test-password';
      process.env.EMAIL_SMTP_PASSWORD_FILE = '';
      process.env.EMAIL_SMTP_TLS_MODE = 'starttls';
      process.env.EMAIL_SMTP_TIMEOUT_SECONDS = '5';
      process.env.EMAIL_SENDER_ADDRESS = 'noreply@example.test';
      process.env.EMAIL_SENDER_DISPLAY_NAME = 'MyOTA Recovery Test';
      process.env.MYOTA_EMAIL_SERVICE_CLIENT_SECRET = 'x'.repeat(32);
      process.env.MYOTA_EMAIL_SERVICE_CLIENT_SECRET_FILE = '';
      process.env.MYOTA_IDENTITY_URL = 'http://identity.invalid';

      server = await startJetStream(port, directory);
      publisher = await connect({
        servers: natsUrl,
        name: 'email-recovery-publisher',
        maxReconnectAttempts: -1,
        reconnectTimeWait: 100,
      });
      const manager = await jetstreamManager(publisher);
      await addTestStreamWithPlacementRetry(manager, {
        name: stream,
        subjects: [subject],
        retention: RetentionPolicy.Workqueue,
        storage: StorageType.File,
        num_replicas: 1,
        max_age: 3_600_000_000_000,
        max_bytes: 16 * 1024 * 1024,
        max_msgs: 100,
        max_msg_size: 1024 * 1024,
      } as StreamConfig);
      await manager.consumers.add(stream, {
        durable_name: durable,
        filter_subject: subject,
        deliver_policy: DeliverPolicy.All,
        ack_policy: AckPolicy.Explicit,
        ack_wait: 90_000_000_000,
        max_deliver: 8,
        max_ack_pending: 1,
        max_waiting: 1,
        replay_policy: ReplayPolicy.Instant,
        num_replicas: 0,
      } as ConsumerConfig);

      const worker = new EmailWorkerService(pool);
      const internals = worker as unknown as {
        handle(message: JsMsg): Promise<void>;
        resolveRecipient(
          accountId: string,
          templateId: string,
        ): Promise<string>;
        transporter: {
          sendMail(message: unknown): Promise<void>;
          close(): void;
        };
      };
      internals.resolveRecipient = async () => 'participant@example.test';
      internals.transporter = {
        sendMail: async () => {
          smtpAttempts++;
          if (!smtpAvailable) throw new Error('injected SMTP outage');
        },
        close: () => undefined,
      };

      const recipientAccountId = randomUUID();
      const command = {
        envelopeVersion: 1,
        workId,
        workType: 'email.send.v1',
        createdAt: new Date().toISOString(),
        producer: 'myota-identity',
        payload: {
          requestId: workId,
          recipientAccountId,
          templateId: 'account-created-participant.v1',
          templateData: { displayName: 'Recovery Test' },
        },
      };
      const publishCommand = async () =>
        await jetstream(publisher!).publish(
          subject,
          new TextEncoder().encode(JSON.stringify(command)),
        );
      await publishCommand();
      const consumer = await jetstream(publisher).consumers.get(
        stream,
        durable,
      );
      const observedDeliveries: number[] = [];
      for (let attempt = 1; attempt <= 8; attempt++) {
        const brokerMessage = await consumer.next({ expires: 10_000 });
        if (!brokerMessage)
          throw new Error(`Email work delivery ${attempt} did not arrive`);
        observedDeliveries.push(brokerMessage.info.deliveryCount);
        const message = new Proxy(brokerMessage, {
          get(target, property, receiver) {
            if (property === 'nak') return () => target.nak(1);
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        await internals.handle(message);
        const saved = await pool.query<{
          attempts: number;
          status: string;
          last_error_code: string | null;
        }>(
          `SELECT attempts,status,last_error_code FROM public.email_delivery
           WHERE work_id=$1`,
          [workId],
        );
        if (attempt < 8) {
          expect(saved.rows[0]).toMatchObject({
            attempts: attempt,
            status: 'PENDING',
            last_error_code: 'transient_delivery_failure',
          });
        } else {
          expect(saved.rows[0]).toMatchObject({
            attempts: 8,
            status: 'DEAD_LETTER',
            last_error_code: 'delivery_exhausted',
          });
        }
      }

      expect(observedDeliveries).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(smtpAttempts).toBe(8);
      const terminalAttempt = await pool.query<{
        outcome: string;
        count: number;
      }>(
        `SELECT outcome,count(*)::int AS count FROM public.email_delivery_attempt
         WHERE work_id=$1 GROUP BY outcome ORDER BY outcome`,
        [workId],
      );
      expect(terminalAttempt.rows).toEqual([
        { outcome: 'dead_letter', count: 1 },
        { outcome: 'retryable_failure', count: 7 },
      ]);
      const deadLetter = await pool.query<{
        error_code: string;
        count: number;
      }>(
        `SELECT error_code,count(*)::int AS count FROM public.email_dead_letter
         WHERE work_id=$1 GROUP BY error_code`,
        [workId],
      );
      expect(deadLetter.rows).toEqual([
        { error_code: 'delivery_exhausted', count: 1 },
      ]);
      const settled = await manager.consumers.info(stream, durable);
      expect(settled.num_ack_pending).toBe(0);
      expect(settled.num_pending).toBe(0);

      const redrive = await runEmailRedrive(workId, natsUrl);
      expect(redrive).toContain('Audited redrive recorded');
      const redriveState = await pool.query<{
        status: string;
        attempts: number;
        actor: string;
        reason: string;
        resolved_at: Date | null;
      }>(
        `SELECT d.status,d.attempts,l.redrive_actor AS actor,
                l.redrive_reason AS reason,l.resolved_at
           FROM public.email_delivery d
           JOIN public.email_dead_letter l USING (work_id)
          WHERE d.work_id=$1 AND l.error_code='delivery_exhausted'`,
        [workId],
      );
      expect(redriveState.rows[0]).toMatchObject({
        status: 'PENDING',
        attempts: 8,
        actor: 'ci-recovery-test',
        reason: 'verify audited Email recovery',
        resolved_at: null,
      });

      smtpAvailable = true;
      await publishCommand();
      const replay = await consumer.next({ expires: 10_000 });
      if (!replay) throw new Error('Email redrive replay did not arrive');
      await internals.handle(replay);

      const recovered = await pool.query<{ status: string; attempts: number }>(
        `SELECT status,attempts FROM public.email_delivery WHERE work_id=$1`,
        [workId],
      );
      expect(recovered.rows[0]).toEqual({ status: 'DELIVERED', attempts: 9 });
      expect(smtpAttempts).toBe(9);
      const resolvedDeadLetter = await pool.query<{
        redrive_actor: string;
        redrive_reason: string;
        resolved_at: Date | null;
      }>(
        `SELECT redrive_actor,redrive_reason,resolved_at
           FROM public.email_dead_letter
          WHERE work_id=$1 AND error_code='delivery_exhausted'`,
        [workId],
      );
      expect(resolvedDeadLetter.rows[0]).toMatchObject({
        redrive_actor: 'ci-recovery-test',
        redrive_reason: 'verify audited Email recovery',
      });
      expect(resolvedDeadLetter.rows[0]?.resolved_at).toBeInstanceOf(Date);
      const redriveAudit = await pool.query(
        `SELECT 1 FROM public.email_dead_letter_redrive
          WHERE work_id=$1 AND error_code='delivery_exhausted'
            AND actor='ci-recovery-test' AND reason='verify audited Email recovery'`,
        [workId],
      );
      expect(redriveAudit.rowCount).toBe(1);
    } finally {
      await publisher?.drain().catch(() => undefined);
      if (server) await stopJetStream(server);
      await pool
        .query('DELETE FROM public.email_delivery_attempt WHERE work_id=$1', [
          workId,
        ])
        .catch(() => undefined);
      await pool
        .query('DELETE FROM public.email_dead_letter WHERE work_id=$1', [
          workId,
        ])
        .catch(() => undefined);
      await pool
        .query(
          'DELETE FROM public.email_dead_letter_redrive WHERE work_id=$1',
          [workId],
        )
        .catch(() => undefined);
      await pool
        .query('DELETE FROM public.email_delivery WHERE work_id=$1', [workId])
        .catch(() => undefined);
      await pool.end().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
      for (const [name, value] of previousEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }, 120_000);
});

async function runEmailRedrive(workId: string, natsUrl: string) {
  return await new Promise<string>((resolveRedrive, rejectRedrive) => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        resolve(process.cwd(), 'apps/email-worker/src/redrive-email.ts'),
        '--work-id',
        workId,
        '--error-code',
        'delivery_exhausted',
        '--actor',
        'ci-recovery-test',
        '--reason',
        'verify audited Email recovery',
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CORE_DATABASE_URL: process.env.CORE_DATABASE_URL,
          NATS_URL: natsUrl,
        },
      },
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
      if (code === 0) resolveRedrive(stdout);
      else
        rejectRedrive(new Error(`Email redrive failed (${code}): ${stderr}`));
    });
  });
}

async function reserveLocalPort() {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('could not reserve a JetStream port'));
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
      throw new Error(`JetStream failed to start: ${output}`);
    if (output.includes('Server is ready')) return server;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  server.kill('SIGKILL');
  throw new Error(`JetStream did not start: ${output}`);
}

async function stopJetStream(server: ReturnType<typeof spawn>) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  server.kill('SIGKILL');
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('JetStream did not stop')),
      5000,
    );
    server.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
