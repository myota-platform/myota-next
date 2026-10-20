import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import type { Consumer, JsMsg } from '@nats-io/jetstream';
import { connect } from '@nats-io/transport-node';
import { createTransport } from 'nodemailer';
import type { Pool, PoolClient } from 'pg';
import { readFileSync } from 'node:fs';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { loadOutboxRegistry } from '@app/platform/outbox-routing.js';
import { EmailWorkerTelemetry } from './email-worker-telemetry.js';

const STREAM = 'MYOTA_EMAIL_WORK';
const DURABLE = 'email-delivery-v1';
const SUBJECT = 'myota.work.email.send.v1';
const ACK_WAIT_SECONDS = 90;
const MAX_DELIVERIES = 8;
const LEASE_SECONDS = 60;
const MAX_COMMAND_BYTES = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEMPLATES = new Set([
  'account-created-participant.v1',
  'account-created-administrator.v1',
]);

type EmailCommand = {
  workId: string;
  recipientAccountId: string;
  templateId: string;
  templateData: Record<string, unknown>;
};

type SmtpConfig = {
  host: string;
  port: number;
  username: string;
  password: string;
  tlsMode: 'starttls' | 'implicit';
  timeoutMs: number;
};

type Sender = { address: string; displayName: string };

@Injectable()
export class EmailWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmailWorkerService.name);
  private stopping = false;
  private connection?: Awaited<ReturnType<typeof connect>>;
  private consumer?: Consumer;
  private manager?: Awaited<ReturnType<typeof jetstreamManager>>;
  private loop?: Promise<void>;
  private transporter?: ReturnType<typeof createTransport>;
  private identityToken = '';
  private identityTokenExpiresAt = 0;
  private readonly identityClientSecret: string;
  private readonly pool: Pool | null;
  private readonly smtp: SmtpConfig;
  private readonly identityUrl: string;
  private readonly sender: Sender;
  private readonly telemetry = new EmailWorkerTelemetry();

  constructor(@Inject(DATABASE_HEALTH_POOL) pool: Pool | null) {
    this.pool = pool;
    this.smtp = smtpConfig();
    this.sender = senderConfig();
    this.identityClientSecret = readSecret('MYOTA_EMAIL_SERVICE_CLIENT_SECRET');
    if (this.identityClientSecret.length < 32)
      throw new Error('email service credential is unavailable');
    this.identityUrl = identityBaseUrl();
  }

  async onModuleInit() {
    if (!this.pool) throw new Error('CORE_DATABASE_URL is required');
    await this.pool.query('SELECT 1');
    const registry = await loadOutboxRegistry();
    const work = registry.work.find(
      (item) => item.workType === 'email.send.v1',
    );
    if (
      work?.stream !== STREAM ||
      work.durable !== DURABLE ||
      work.subject !== SUBJECT
    )
      throw new Error('Email work contract does not match the worker');
    this.transporter = createTransport({
      host: this.smtp.host,
      port: this.smtp.port,
      secure: this.smtp.tlsMode === 'implicit',
      requireTLS: this.smtp.tlsMode === 'starttls',
      auth: { user: this.smtp.username, pass: this.smtp.password },
      connectionTimeout: this.smtp.timeoutMs,
      greetingTimeout: this.smtp.timeoutMs,
      socketTimeout: this.smtp.timeoutMs,
    });
    this.connection = await connect({
      servers: process.env.NATS_URL ?? 'nats://nats:4222',
      name: 'email-worker',
      timeout: 5000,
      reconnect: true,
      maxReconnectAttempts: -1,
    });
    try {
      this.manager = await jetstreamManager(this.connection);
      const info = await this.manager.consumers.info(STREAM, DURABLE);
      this.validateConsumer(info.config);
      this.consumer = await jetstream(this.connection).consumers.get(
        STREAM,
        DURABLE,
      );
      await this.telemetry.listen();
      this.telemetry.setReady(true);
      this.loop = this.consume();
      this.logger.log('Email worker is ready');
    } catch (error) {
      await this.connection.drain();
      throw error;
    }
  }

  async onModuleDestroy() {
    this.stopping = true;
    this.telemetry.setReady(false);
    await this.loop;
    await this.connection?.drain();
    this.transporter?.close();
    await this.telemetry.close();
  }

  private validateConsumer(config: {
    filter_subject?: string;
    ack_policy?: unknown;
    ack_wait?: number;
    max_deliver?: number;
    max_ack_pending?: number;
    max_waiting?: number;
    deliver_policy?: unknown;
    replay_policy?: unknown;
    deliver_subject?: string;
  }) {
    if (
      config.filter_subject !== SUBJECT ||
      String(config.ack_policy).toLowerCase() !== 'explicit' ||
      Number(config.ack_wait) !== ACK_WAIT_SECONDS * 1_000_000_000 ||
      config.max_deliver !== MAX_DELIVERIES ||
      config.max_ack_pending !== 1 ||
      config.max_waiting !== 1 ||
      String(config.deliver_policy).toLowerCase() !== 'all' ||
      String(config.replay_policy).toLowerCase() !== 'instant' ||
      config.deliver_subject != null
    )
      throw new Error('Email durable does not match the registered policy');
  }

  private async consume() {
    let lastMetricsAt = 0;
    while (!this.stopping) {
      try {
        const message = await this.consumer?.next({ expires: 1000 });
        if (message) await this.handle(message);
        if (Date.now() - lastMetricsAt >= 15_000) {
          lastMetricsAt = Date.now();
          await this.refreshQueueMetrics();
        }
      } catch (error) {
        if (!this.stopping) {
          this.logger.error(`Email message poll failed: ${safeError(error)}`);
          await pause(1000);
        }
      }
    }
  }

  private async handle(message: JsMsg) {
    const startedAt = Date.now();
    let command: EmailCommand;
    try {
      command = parseCommand(message.data);
    } catch {
      await this.deadLetter(null, 'invalid_command');
      message.term();
      this.telemetry.record('invalid_command', 'unknown');
      this.logger.warn('Rejected an invalid email command');
      return;
    }
    const state = await this.claim(command);
    if (state === 'DELIVERED' || state === 'DEAD_LETTER') {
      message.ack();
      this.telemetry.record('duplicate', command.templateId);
      return;
    }
    if (state === 'IN_PROGRESS') {
      message.nak(2000);
      return;
    }
    let stage: 'identity' | 'smtp' = 'identity';
    let smtpStartedAt = 0;
    try {
      const address = await this.resolveRecipient(command.recipientAccountId);
      const content = renderMessage(command);
      stage = 'smtp';
      smtpStartedAt = Date.now();
      await this.transporter?.sendMail({
        from: { name: this.sender.displayName, address: this.sender.address },
        to: address,
        subject: content.subject,
        text: content.text,
        html: content.html,
      });
      this.telemetry.smtpResult(true);
      this.telemetry.observeSmtpDuration(
        command.templateId,
        (Date.now() - smtpStartedAt) / 1000,
      );
      await this.markDelivered(command.workId);
      message.ack();
      this.telemetry.record('delivered', command.templateId);
      this.telemetry.observeDuration(
        command.templateId,
        (Date.now() - startedAt) / 1000,
      );
    } catch (error) {
      if (error instanceof RecipientUnavailable) {
        await this.deadLetter(command.workId, 'recipient_unavailable');
        message.term();
        this.telemetry.record('dead_letter', command.templateId);
        this.telemetry.observeDuration(
          command.templateId,
          (Date.now() - startedAt) / 1000,
        );
        this.logger.warn('Email recipient is unavailable');
        return;
      }
      if (message.info.deliveryCount >= MAX_DELIVERIES) {
        await this.deadLetter(command.workId, 'delivery_exhausted');
        message.term();
        this.telemetry.record('dead_letter', command.templateId);
        this.telemetry.observeDuration(
          command.templateId,
          (Date.now() - startedAt) / 1000,
        );
        this.logger.error('Email delivery exhausted its retry limit');
        return;
      }
      const attempts = await this.retry(command.workId);
      message.nak(backoffMs(Math.max(message.info.deliveryCount, attempts)));
      this.telemetry.record(
        stage === 'smtp' ? 'smtp_failure' : 'identity_failure',
        command.templateId,
      );
      this.telemetry.observeDuration(
        command.templateId,
        (Date.now() - startedAt) / 1000,
      );
      if (stage === 'smtp') {
        this.telemetry.smtpResult(false);
        this.telemetry.observeSmtpDuration(
          command.templateId,
          (Date.now() - smtpStartedAt) / 1000,
        );
      }
      this.logger.warn(`Email delivery will retry: ${safeError(error)}`);
    }
  }

  private async refreshQueueMetrics() {
    try {
      const info = await this.manager?.consumers.info(STREAM, DURABLE);
      if (!info || !this.pool)
        throw new Error('email dependencies unavailable');
      await this.pool.query('SELECT 1');
      let oldestAge = 0;
      if (info.num_pending + info.num_ack_pending > 0) {
        try {
          const oldest = await this.manager?.streams.getMessage(STREAM, {
            seq: info.ack_floor.stream_seq + 1,
          });
          if (oldest)
            oldestAge = Math.max(
              0,
              (Date.now() - oldest.time.getTime()) / 1000,
            );
        } catch {
          oldestAge = 0;
        }
      }
      this.telemetry.updateQueue(
        info.num_pending,
        info.num_ack_pending,
        oldestAge,
      );
      this.telemetry.setReady(true);
    } catch {
      // Queue metrics must not interrupt message delivery.
      this.telemetry.setReady(false);
    }
  }

  private async resolveRecipient(accountId: string): Promise<string> {
    if (!this.identityToken || Date.now() >= this.identityTokenExpiresAt) {
      const tokenResponse = await fetch(
        `${this.identityUrl}/v1/identity/auth/service-token`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            service: 'email-service',
            clientSecret: this.identityClientSecret,
          }),
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!tokenResponse.ok)
        throw new Error('Identity service authentication failed');
      const tokenBody: unknown = await tokenResponse.json();
      if (!isRecord(tokenBody) || typeof tokenBody.accessToken !== 'string')
        throw new Error('Identity service returned an invalid token response');
      this.identityToken = tokenBody.accessToken;
      const expiresIn = boundedInteger(tokenBody.expiresIn, 300, 30, 300);
      this.identityTokenExpiresAt = Date.now() + (expiresIn - 30) * 1000;
    }
    const response = await fetch(
      `${this.identityUrl}/v1/identity/internal/email-recipients/${accountId}`,
      {
        headers: { authorization: `Bearer ${this.identityToken}` },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (response.status === 400 || response.status === 404)
      throw new RecipientUnavailable();
    if (!response.ok) throw new Error('Identity recipient lookup failed');
    const body: unknown = await response.json();
    if (!isRecord(body) || typeof body.deliverableAddress !== 'string')
      throw new RecipientUnavailable();
    return validateEmail(body.deliverableAddress);
  }

  private async claim(command: EmailCommand) {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO public.email_delivery(work_id,template_id,status)
         VALUES ($1,$2,'PENDING') ON CONFLICT (work_id) DO NOTHING`,
        [command.workId, command.templateId],
      );
      const selected = await client.query(
        `SELECT status,lease_until FROM public.email_delivery
         WHERE work_id=$1 FOR UPDATE`,
        [command.workId],
      );
      const row = selected.rows[0] as
        { status: string; lease_until: Date | null } | undefined;
      if (!row) throw new Error('email delivery row was not created');
      if (row.status === 'DELIVERED' || row.status === 'DEAD_LETTER') {
        await client.query('COMMIT');
        return row.status;
      }
      if (
        row.status === 'PROCESSING' &&
        row.lease_until &&
        row.lease_until.getTime() > Date.now()
      ) {
        await client.query('COMMIT');
        return 'IN_PROGRESS';
      }
      await client.query(
        `UPDATE public.email_delivery
         SET status='PROCESSING',attempts=attempts+1,
             lease_until=now()+make_interval(secs=>$2),updated_at=now()
         WHERE work_id=$1`,
        [command.workId, LEASE_SECONDS],
      );
      await client.query(
        `INSERT INTO public.email_delivery_attempt(work_id,outcome)
         VALUES ($1,'started')`,
        [command.workId],
      );
      await client.query('COMMIT');
      return 'CLAIMED';
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async markDelivered(workId: string) {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE public.email_delivery SET status='DELIVERED',delivered_at=now(),
         lease_until=NULL,last_error_code=NULL,updated_at=now() WHERE work_id=$1`,
        [workId],
      );
      await client.query(
        `UPDATE public.email_delivery_attempt SET outcome='delivered'
         WHERE id=(SELECT id FROM public.email_delivery_attempt
          WHERE work_id=$1 AND outcome='started' ORDER BY attempted_at DESC,id DESC LIMIT 1)`,
        [workId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async retry(workId: string): Promise<number> {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ attempts: number }>(
        `UPDATE public.email_delivery SET status='PENDING',lease_until=NULL,
         last_error_code='transient_delivery_failure',updated_at=now() WHERE work_id=$1
         RETURNING attempts`,
        [workId],
      );
      const attempts = result.rows[0]?.attempts;
      if (attempts === undefined)
        throw new Error('email delivery row disappeared during retry');
      await client.query(
        `UPDATE public.email_delivery_attempt SET outcome='retryable_failure',
         error_code='transient_delivery_failure' WHERE id=(
          SELECT id FROM public.email_delivery_attempt WHERE work_id=$1
          AND outcome='started' ORDER BY attempted_at DESC,id DESC LIMIT 1)`,
        [workId],
      );
      await client.query('COMMIT');
      return attempts;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async deadLetter(workId: string | null, code: string) {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      if (workId) {
        await client.query(
          `UPDATE public.email_delivery SET status='DEAD_LETTER',lease_until=NULL,
           last_error_code=$2,updated_at=now() WHERE work_id=$1`,
          [workId, code],
        );
        await client.query(
          `UPDATE public.email_delivery_attempt SET outcome='dead_letter',error_code=$2
           WHERE id=(SELECT id FROM public.email_delivery_attempt WHERE work_id=$1
            AND outcome='started' ORDER BY attempted_at DESC,id DESC LIMIT 1)`,
          [workId, code],
        );
      }
      if (workId) {
        await client.query(
          `INSERT INTO public.email_dead_letter(work_id,error_code)
           VALUES ($1,$2) ON CONFLICT (work_id,error_code) DO UPDATE
           SET recorded_at=now(),redrive_requested_at=NULL,redrive_actor=NULL,
               redrive_reason=NULL,resolved_at=NULL`,
          [workId, code],
        );
      } else {
        await client.query(
          `INSERT INTO public.email_dead_letter(work_id,error_code)
           VALUES (NULL,$1) ON CONFLICT DO NOTHING`,
          [code],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async connect(): Promise<PoolClient> {
    if (!this.pool) throw new Error('Core database is not configured');
    return this.pool.connect();
  }
}

class RecipientUnavailable extends Error {}

function parseCommand(raw: Uint8Array): EmailCommand {
  if (raw.byteLength > MAX_COMMAND_BYTES)
    throw new Error('email command exceeds contract limit');
  const envelope: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(raw),
  );
  if (
    !isRecord(envelope) ||
    !hasOnly(envelope, [
      'envelopeVersion',
      'workId',
      'workType',
      'createdAt',
      'producer',
      'aggregate',
      'correlationId',
      'causationId',
      'payload',
    ]) ||
    envelope.envelopeVersion !== 1 ||
    envelope.workType !== 'email.send.v1' ||
    !isStringWithinLength(envelope.producer, 1, 80) ||
    !UUID.test(String(envelope.workId)) ||
    typeof envelope.createdAt !== 'string' ||
    !isValidUtcDateTime(envelope.createdAt) ||
    (envelope.aggregate !== undefined && !isRecord(envelope.aggregate)) ||
    (envelope.correlationId !== undefined &&
      !isStringWithinLength(envelope.correlationId, 0, 200)) ||
    (envelope.causationId !== undefined &&
      !isStringWithinLength(envelope.causationId, 0, 200)) ||
    !isRecord(envelope.payload)
  )
    throw new Error('invalid email command envelope');
  const payload = envelope.payload;
  if (
    !hasOnly(payload, ['recipientAccountId', 'templateId', 'templateData']) ||
    !UUID.test(String(payload.recipientAccountId)) ||
    typeof payload.templateId !== 'string' ||
    !TEMPLATES.has(payload.templateId) ||
    !isRecord(payload.templateData)
  )
    throw new Error('invalid email command payload');
  const data = payload.templateData;
  if (payload.templateId === 'account-created-participant.v1') {
    if (!hasOnly(data, ['displayName']) || !validText(data.displayName, 120))
      throw new Error('invalid participant email data');
  } else if (
    !hasOnly(data, ['createdAccountName', 'createdAccountRole']) ||
    !validText(data.createdAccountName, 120) ||
    !['PARTICIPANT', 'ADMINISTRATOR'].includes(String(data.createdAccountRole))
  )
    throw new Error('invalid administrator email data');
  return {
    workId: String(envelope.workId).toLowerCase(),
    recipientAccountId: String(payload.recipientAccountId).toLowerCase(),
    templateId: payload.templateId,
    templateData: data,
  };
}

function isValidUtcDateTime(value: string) {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value);
  if (!match || match[0] !== value) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day >= 1 && day <= daysInMonth[month - 1];
}

function renderMessage(command: EmailCommand) {
  if (command.templateId === 'account-created-participant.v1') {
    const name = String(command.templateData.displayName);
    return {
      subject: 'Your MyOTA account is ready',
      text: `Hello ${name},\n\nYour MyOTA participant account has been created.\n`,
      html: `<p>Hello ${escapeHtml(name)},</p><p>Your MyOTA participant account has been created.</p>`,
    };
  }
  const name = String(command.templateData.createdAccountName);
  const role = String(command.templateData.createdAccountRole).toLowerCase();
  return {
    subject: 'A MyOTA account was created',
    text: `Hello,\n\nA ${role} account for ${name} was created.\n`,
    html: `<p>Hello,</p><p>A ${escapeHtml(role)} account for ${escapeHtml(name)} was created.</p>`,
  };
}

function smtpConfig(): SmtpConfig {
  const port = Number(process.env.EMAIL_SMTP_PORT);
  const timeout = Number(process.env.EMAIL_SMTP_TIMEOUT_SECONDS ?? 10);
  const tlsMode = process.env.EMAIL_SMTP_TLS_MODE ?? 'starttls';
  const config = {
    host: process.env.EMAIL_SMTP_HOST?.trim() ?? '',
    port,
    username: process.env.EMAIL_SMTP_USERNAME ?? '',
    password: readSecret('EMAIL_SMTP_PASSWORD'),
    tlsMode,
    timeoutMs: timeout * 1000,
  };
  if (
    !config.host ||
    !config.username ||
    !config.password ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !Number.isFinite(timeout) ||
    timeout < 1 ||
    timeout > 30 ||
    !['starttls', 'implicit'].includes(tlsMode)
  )
    throw new Error('SMTP configuration is incomplete or outside bounds');
  return { ...config, tlsMode: tlsMode as SmtpConfig['tlsMode'] };
}

function readSecret(name: string) {
  const inline = process.env[name] ?? '';
  const path = process.env[`${name}_FILE`];
  if (inline && path)
    throw new Error(`${name} and ${name}_FILE cannot both be configured`);
  if (!path) return inline;
  try {
    return readFileSync(path, 'utf8').replace(/[\r\n]+$/, '');
  } catch {
    throw new Error(`${name} secret file is unavailable`);
  }
}

function senderConfig(): Sender {
  const address = process.env.EMAIL_SENDER_ADDRESS?.trim() ?? '';
  const displayName = process.env.EMAIL_SENDER_DISPLAY_NAME ?? 'MyOTA';
  validateEmail(address);
  if (/[\r\n]/.test(displayName)) throw new Error('invalid email sender name');
  return { displayName, address };
}

function identityBaseUrl() {
  const raw = process.env.MYOTA_IDENTITY_URL ?? 'http://identity:8001';
  const url = new URL(raw);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error(
      'MYOTA_IDENTITY_URL must be an HTTP(S) URL without credentials',
    );
  return raw.replace(/\/$/, '');
}

function validateEmail(address: string) {
  if (
    address.length > 254 ||
    /[\r\n\s]/.test(address) ||
    !/^[^@]+@[^@]+\.[^@]+$/.test(address)
  )
    throw new Error('invalid email address');
  return address;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character];
  });
}

function validText(value: unknown, maxLength: number): value is string {
  return isStringWithinLength(value, 1, maxLength);
}

function isStringWithinLength(
  value: unknown,
  minLength: number,
  maxLength: number,
): value is string {
  if (typeof value !== 'string') return false;
  const characterCount = Array.from(value).length;
  return characterCount >= minLength && characterCount <= maxLength;
}

function hasOnly(record: Record<string, unknown>, keys: string[]) {
  return Object.keys(record).every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

function backoffMs(attempt: number) {
  return Math.min(300_000, 2 ** Math.min(Math.max(attempt - 1, 0), 8) * 1000);
}

function safeError(error: unknown) {
  return error instanceof Error ? error.name : 'unknown';
}

function pause(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
