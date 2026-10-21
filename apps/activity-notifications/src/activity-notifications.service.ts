import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import {
  AckPolicy,
  DeliverPolicy,
  jetstream,
  jetstreamManager,
  ReplayPolicy,
} from '@nats-io/jetstream';
import type { Consumer, ConsumerConfig, JsMsg } from '@nats-io/jetstream';
import { connect } from '@nats-io/transport-node';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { integerSetting } from '@app/platform/integer-setting.js';
import { pythonTruthy } from '@app/platform/python-truthiness.js';

const CONSUMER = 'activity-notifications';
const STREAM = 'MYOTA_EVENTS';
const DURABLE =
  process.env.ACTIVITY_NOTIFICATION_DURABLE ?? 'activity-notifications-v1';
const DEFAULT_DURABLE = 'activity-notifications-v1';
const START_SEQUENCE = optionalPositiveSetting(
  'ACTIVITY_NOTIFICATION_START_SEQUENCE',
);
const MAX_MESSAGES = optionalPositiveSetting(
  'ACTIVITY_NOTIFICATION_MAX_MESSAGES',
);
const MAX_DELIVERIES = 8;
const METRICS_PORT = Math.max(
  0,
  Number(process.env.ACTIVITY_NOTIFICATION_METRICS_PORT ?? 9110),
);
const SUBJECTS = [
  'myota.events.geodata.entity.reviewed.v1',
  'myota.events.geodata.entity.status-changed.v1',
  'myota.events.identity.account.admin-updated.v1',
  'myota.events.identity.account.created.v1',
  'myota.events.identity.account.deactivated.v1',
  'myota.events.identity.bootstrap-admin.created.v1',
  'myota.events.identity.callsign.added.v1',
  'myota.events.identity.callsign.evidence-submitted.v1',
  'myota.events.identity.callsign.primary-changed.v1',
  'myota.events.identity.callsign.retired.v1',
  'myota.events.identity.callsign.verified.v1',
  'myota.events.identity.login.failed.v1',
  'myota.events.identity.login.succeeded.v1',
  'myota.events.identity.oidc.mapping.updated.v1',
  'myota.events.identity.recovery.completed.v1',
  'myota.events.identity.recovery.requested.v1',
  'myota.events.identity.role-definition.created.v1',
  'myota.events.identity.role-definition.updated.v1',
  'myota.events.identity.role.assigned.v1',
  'myota.events.identity.roles.replaced.v1',
  'myota.events.identity.service-token.issued.v1',
];
const SENSITIVE = [
  'password',
  'secret',
  'token',
  'authorization',
  'credential',
  'email',
  'address',
  'remoteaddr',
  'ipaddress',
  'phone',
];

type Envelope = {
  eventId?: unknown;
  eventType?: unknown;
  aggregate?: unknown;
  payload?: unknown;
};

@Injectable()
export class ActivityNotificationsService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ActivityNotificationsService.name);
  private stopping = false;
  private connection?: Awaited<ReturnType<typeof connect>>;
  private messages?: Consumer;
  private metricsServer?: Server;
  private natsUp = false;
  private outcomes = new Map<string, number>();
  private unresolvedDeadLetters = 0;
  private completedMessages = 0;

  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.pool) throw new Error('ACTIVITY_DATABASE_URL is required');
    const connection = await connect({
      servers: process.env.NATS_URL ?? 'nats://nats:4222',
      name: CONSUMER,
      timeout: 5000,
      reconnect: true,
      maxReconnectAttempts: -1,
    });
    this.connection = connection;
    try {
      const js = jetstream(connection);
      const manager = await jetstreamManager(connection);
      if (DURABLE !== DEFAULT_DURABLE && START_SEQUENCE === undefined)
        throw new Error(
          'ACTIVITY_NOTIFICATION_START_SEQUENCE is required for replay durables',
        );
      if (DURABLE === DEFAULT_DURABLE && START_SEQUENCE !== undefined)
        throw new Error(
          'ACTIVITY_NOTIFICATION_START_SEQUENCE requires a replay durable name',
        );
      let consumerInfo;
      try {
        consumerInfo = await manager.consumers.info(STREAM, DURABLE);
      } catch (error) {
        if (DURABLE === DEFAULT_DURABLE || !isNotFound(error)) throw error;
        await manager.consumers.add(STREAM, replayConsumerConfig());
        consumerInfo = await manager.consumers.info(STREAM, DURABLE);
      }
      this.validateConsumer(consumerInfo.config, START_SEQUENCE);
      this.messages = await js.consumers.get(STREAM, DURABLE);
      this.natsUp = true;
      void this.monitorNats();
      await this.refreshDeadLetterGauge();
      this.startMetricsServer();
      void this.consume();
    } catch (error) {
      this.stopping = true;
      this.connection = undefined;
      this.messages = undefined;
      try {
        await connection.drain();
      } catch (drainError) {
        this.logger.warn(
          `Unable to drain NATS after notification startup failure: ${this.safeError(drainError)}`,
        );
      }
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.metricsServer) {
      await new Promise<void>((resolve, reject) => {
        this.metricsServer!.close((error) =>
          error ? reject(error) : resolve(),
        );
      });
    }
    await this.connection?.drain();
  }

  private startMetricsServer(): void {
    if (METRICS_PORT === 0) return;
    this.metricsServer = createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/healthz') {
        response.writeHead(this.stopping ? 503 : 200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(this.stopping ? 'stopping\n' : 'ok\n');
        return;
      }
      if (request.method === 'GET' && request.url === '/readyz') {
        void this.respondReadiness(response);
        return;
      }
      if (request.method !== 'GET' || request.url !== '/metrics') {
        response.writeHead(404).end();
        return;
      }
      const lines = [
        '# HELP myota_activity_notification_outcomes_total Activity notification deliveries by bounded outcome.',
        '# TYPE myota_activity_notification_outcomes_total counter',
        ...[...this.outcomes.entries()].map(
          ([outcome, count]) =>
            `myota_activity_notification_outcomes_total{outcome="${outcome}"} ${count}`,
        ),
        '# HELP myota_activity_notification_unresolved_dead_letters Unresolved Activity notification poison events in PostgreSQL.',
        '# TYPE myota_activity_notification_unresolved_dead_letters gauge',
        `myota_activity_notification_unresolved_dead_letters ${this.unresolvedDeadLetters}`,
      ];
      response.writeHead(200, {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      });
      response.end(`${lines.join('\n')}\n`);
    });
    this.metricsServer.listen(METRICS_PORT, '0.0.0.0');
  }

  private async respondReadiness(response: ServerResponse): Promise<void> {
    try {
      if (
        this.stopping ||
        !this.pool ||
        !this.connection ||
        !this.natsUp ||
        !this.messages
      ) {
        response.writeHead(503, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end('not ready\n');
        return;
      }
      await this.pool.query('SELECT 1');
      response.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end('ready\n');
    } catch {
      if (!response.headersSent) {
        response.writeHead(503, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        });
      }
      response.end('not ready\n');
    }
  }

  private countOutcome(outcome: string): void {
    this.outcomes.set(outcome, (this.outcomes.get(outcome) ?? 0) + 1);
  }

  private async monitorNats(): Promise<void> {
    try {
      for await (const status of this.connection!.status()) {
        if (status.type === 'disconnect' || status.type === 'reconnecting') {
          this.natsUp = false;
        } else if (status.type === 'reconnect') {
          this.natsUp = true;
        } else if (status.type === 'close') {
          this.natsUp = false;
          return;
        }
      }
    } catch (error) {
      this.natsUp = false;
      this.logger.warn(`NATS status monitor stopped: ${this.safeError(error)}`);
    }
  }

  private async refreshDeadLetterGauge(): Promise<void> {
    const result = await this.pool!.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.dead_letter_event
       WHERE stream_name=$1 AND resolved_at IS NULL`,
      [STREAM],
    );
    this.unresolvedDeadLetters = Number(result.rows[0]?.count ?? 0);
  }

  private validateConsumer(
    config: {
      filter_subjects?: string[];
      ack_policy?: unknown;
      deliver_policy?: unknown;
      replay_policy?: unknown;
      ack_wait?: number;
      max_deliver?: number;
      max_ack_pending?: number;
      max_waiting?: number;
      backoff?: number[];
      deliver_subject?: string;
      opt_start_seq?: number;
    },
    startSequence?: number,
  ): void {
    const backoff = [60, 120, 300, 300, 300, 300, 300, 300].map(
      (seconds) => seconds * 1_000_000_000,
    );
    if (
      JSON.stringify(config.filter_subjects ?? []) !==
        JSON.stringify(SUBJECTS) ||
      String(config.ack_policy).toLowerCase() !== 'explicit' ||
      String(config.deliver_policy).toLowerCase() !==
        (startSequence === undefined ? 'all' : 'by_start_sequence') ||
      String(config.replay_policy).toLowerCase() !== 'instant' ||
      (startSequence !== undefined && config.opt_start_seq !== startSequence) ||
      Number(config.ack_wait) !== 60_000_000_000 ||
      config.max_deliver !== MAX_DELIVERIES ||
      config.max_ack_pending !== 64 ||
      config.max_waiting !== 32 ||
      config.deliver_subject != null ||
      JSON.stringify(config.backoff ?? []) !== JSON.stringify(backoff)
    )
      throw new Error(
        `${STREAM}/${DURABLE} does not match the registered Activity notification policy`,
      );
  }

  private async consume(): Promise<void> {
    while (!this.stopping) {
      try {
        const message = await this.messages!.next({ expires: 1000 });
        if (message) await this.handle(message);
      } catch (error) {
        if (!this.stopping)
          this.logger.warn(
            `Notification poll failed: ${this.safeError(error)}`,
          );
      }
    }
  }

  private async handle(message: JsMsg): Promise<void> {
    const delivered = message.info.deliveryCount || 1;
    let envelope: Envelope = {};
    let eventType = 'unknown';
    let permanent = false;
    try {
      let decoded: unknown;
      try {
        decoded = JSON.parse(new TextDecoder().decode(message.data));
      } catch {
        permanent = true;
        throw new Error('invalid_envelope');
      }
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
        permanent = true;
        throw new Error('invalid_envelope');
      }
      envelope = decoded as Envelope;
      eventType = pythonTruthy(envelope.eventType)
        ? String(envelope.eventType)
        : 'unknown';
      if (!normalizeUuid(envelope.eventId)) {
        permanent = true;
        throw new Error('invalid_event_id');
      }
      if (eventType !== message.subject.slice('myota.events.'.length)) {
        permanent = true;
        throw new Error('subject_event_type_mismatch');
      }
      const major = Number(eventType.match(/\.v(\d+)$/)?.[1] ?? 0);
      if (major !== 1) {
        permanent = true;
        throw new Error('unsupported_event_version');
      }
      const processed = await this.processEvent(envelope, eventType);
      message.ack();
      this.countOutcome(processed ? 'processed' : 'duplicate');
      this.completedMessages += 1;
      void this.refreshDeadLetterGauge().catch((error: unknown) =>
        this.logger.warn(
          `Unable to refresh dead-letter metrics: ${this.safeError(error)}`,
        ),
      );
      if (
        MAX_MESSAGES !== undefined &&
        this.completedMessages >= MAX_MESSAGES
      ) {
        this.logger.log(
          `Notification replay reached its ${MAX_MESSAGES}-message limit`,
        );
        this.stopping = true;
        setImmediate(() => process.kill(process.pid, 'SIGTERM'));
      }
    } catch (error) {
      if (permanent || delivered >= MAX_DELIVERIES) {
        await this.persistDeadLetter(
          message,
          envelope,
          eventType,
          delivered,
          permanent,
        );
        message.term();
        this.countOutcome('dead_lettered');
        void this.refreshDeadLetterGauge().catch((gaugeError: unknown) =>
          this.logger.warn(
            `Unable to refresh dead-letter metrics: ${this.safeError(gaugeError)}`,
          ),
        );
      } else {
        const delay = Math.min(
          300_000,
          5_000 * 3 ** Math.max(delivered - 1, 0),
        );
        message.nak(delay);
        this.countOutcome('retry');
      }
      this.logger.error(
        `Notification event ${eventType} failed: ${this.safeError(error)}`,
      );
    }
  }

  private async processEvent(
    event: Envelope,
    eventType: string,
  ): Promise<boolean> {
    const client = await this.pool!.connect();
    try {
      await client.query('BEGIN');
      const eventId = normalizeUuid(event.eventId);
      if (!eventId) throw new Error('invalid_event_id');
      const seen = await client.query(
        'SELECT 1 FROM public.consumer_processed_event WHERE consumer=$1 AND event_id=$2',
        [CONSUMER, eventId],
      );
      if (seen.rowCount) {
        await client.query('COMMIT');
        return false;
      }
      const [recipient, kind] = recipientAndKind(event, eventType);
      if (pythonTruthy(recipient) && kind) {
        const notificationEventId = String(event.eventId);
        await client.query(
          `INSERT INTO public.activity_notification
            (id, recipient_id, notification_type, payload, status, delivered_at, deduplication_key)
           VALUES ($1, $2, $3, $4::jsonb, 'DELIVERED', now(), $5)
           ON CONFLICT DO NOTHING`,
          [
            randomUUID(),
            String(recipient),
            kind,
            JSON.stringify({ eventType, eventId: notificationEventId }),
            `event:${notificationEventId}`,
          ],
        );
      }
      await client.query(
        'INSERT INTO public.consumer_processed_event(consumer,event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [CONSUMER, eventId],
      );
      await client.query(
        `INSERT INTO public.consumer_checkpoint(consumer,last_event_id) VALUES ($1,$2)
         ON CONFLICT (consumer) DO UPDATE SET last_event_id=EXCLUDED.last_event_id,updated_at=now()`,
        [CONSUMER, eventId],
      );
      await client.query(
        `UPDATE public.dead_letter_event SET resolved_at=now()
         WHERE event_id=$1 AND stream_name=$2 AND resolved_at IS NULL`,
        [eventId, STREAM],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async persistDeadLetter(
    message: JsMsg,
    event: Envelope,
    eventType: string,
    attempts: number,
    permanent: boolean,
  ): Promise<void> {
    const client: PoolClient = await this.pool!.connect();
    const eventId =
      normalizeUuid(event.eventId) ??
      fallbackEventId(message.subject, message.info.streamSequence);
    const diagnostic = redact(event);
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO public.dead_letter_event
          (event_id,event_type,payload,attempts,error,stream_name,stream_sequence,subject)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8)
         ON CONFLICT (event_id) DO UPDATE SET
           attempts=GREATEST(public.dead_letter_event.attempts,EXCLUDED.attempts),
           error=EXCLUDED.error,stream_name=EXCLUDED.stream_name,
           stream_sequence=EXCLUDED.stream_sequence,subject=EXCLUDED.subject`,
        [
          eventId,
          eventType,
          JSON.stringify(diagnostic),
          attempts,
          permanent
            ? 'invalid_or_unsupported_envelope'
            : 'delivery_attempts_exhausted',
          STREAM,
          message.info.streamSequence,
          message.subject,
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private safeError(error: unknown): string {
    return (error instanceof Error ? error.message : String(error))
      .replace(/[\r\n\t]+/g, ' ')
      .slice(0, 300);
  }
}

function recipientAndKind(
  event: Envelope,
  eventType: string,
): [unknown, string | null] {
  if (
    eventType.startsWith('geodata.entity.reviewed') ||
    eventType.startsWith('geodata.entity.status-changed')
  ) {
    const payload = pythonTruthy(event.payload)
      ? requireRecord(event.payload, 'payload')
      : {};
    let recipient = payload.proposerId;
    if (!pythonTruthy(recipient))
      recipient = optionalMappingValue(payload.review, 'proposerId');
    if (!pythonTruthy(recipient))
      recipient = optionalMappingValue(payload.provenance, 'proposerId');
    return [recipient, 'GEODATA_PROPOSAL_DECISION'];
  }
  if (eventType.startsWith('identity.')) {
    const payload = pythonTruthy(event.payload)
      ? requireRecord(event.payload, 'payload')
      : {};
    let recipient = payload.accountId;
    if (!pythonTruthy(recipient))
      recipient = optionalMappingValue(payload.account, 'id');
    if (!pythonTruthy(recipient))
      recipient = requireRecord(
        event.aggregate === undefined ? {} : event.aggregate,
        'aggregate',
      ).id;
    return [recipient, 'ACCOUNT_SECURITY_EVENT'];
  }
  return [undefined, null];
}

function optionalMappingValue(value: unknown, key: string): unknown {
  return pythonTruthy(value) ? requireRecord(value, key)[key] : undefined;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>;
  throw new TypeError(`${field} must be an object`);
}

function normalizeUuid(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const hex = value
    .replaceAll('urn:', '')
    .replaceAll('uuid:', '')
    .replace(/^\{+|\}+$/g, '')
    .replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) return undefined;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toLowerCase();
}

function fallbackEventId(subject: string, sequence: number): string {
  const hex = createHash('sha256')
    .update(`${subject}:${sequence}`)
    .digest('hex')
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function redact(value: unknown, key = ''): unknown {
  if (SENSITIVE.some((part) => key.toLowerCase().includes(part)))
    return '[REDACTED]';
  if (Array.isArray(value)) return value.map((entry) => redact(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        redact(child, childKey),
      ]),
    );
  }
  return value;
}

function optionalPositiveSetting(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = integerSetting(raw, 0);
  if (value === 0) return undefined;
  if (value < 0) throw new Error(`${name} must be non-negative`);
  return value;
}

function replayConsumerConfig(): ConsumerConfig {
  if (START_SEQUENCE === undefined)
    throw new Error('Replay durable requires a start sequence');
  return {
    durable_name: DURABLE,
    filter_subjects: SUBJECTS,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.StartSequence,
    opt_start_seq: START_SEQUENCE,
    replay_policy: ReplayPolicy.Instant,
    ack_wait: 60_000_000_000,
    max_deliver: MAX_DELIVERIES,
    max_ack_pending: 64,
    max_waiting: 32,
    backoff: [60, 120, 300, 300, 300, 300, 300, 300].map(
      (seconds) => seconds * 1_000_000_000,
    ),
    num_replicas: 0,
  } as ConsumerConfig;
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as {
    code?: unknown;
    status?: unknown;
    api_error?: { code?: unknown };
    apiError?: () => { code?: unknown };
  };
  return (
    value.status === 404 ||
    value.code === '404' ||
    value.api_error?.code === 404 ||
    value.apiError?.().code === 404
  );
}
