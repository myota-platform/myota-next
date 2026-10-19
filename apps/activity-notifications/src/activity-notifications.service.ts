import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import type { Consumer, JsMsg } from '@nats-io/jetstream';
import { connect } from '@nats-io/transport-node';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';

const CONSUMER = 'activity-notifications';
const STREAM = 'MYOTA_EVENTS';
const DURABLE =
  process.env.ACTIVITY_NOTIFICATION_DURABLE ?? 'activity-notifications-v1';
const MAX_DELIVERIES = 8;
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
  aggregate?: { id?: unknown };
  payload?: Record<string, unknown>;
};

@Injectable()
export class ActivityNotificationsService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ActivityNotificationsService.name);
  private stopping = false;
  private connection?: Awaited<ReturnType<typeof connect>>;
  private messages?: Consumer;

  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.pool) throw new Error('ACTIVITY_DATABASE_URL is required');
    this.connection = await connect({
      servers: process.env.NATS_URL ?? 'nats://nats:4222',
      name: CONSUMER,
      timeout: 5000,
      reconnect: true,
      maxReconnectAttempts: -1,
    });
    const js = jetstream(this.connection);
    const manager = await jetstreamManager(this.connection);
    const consumerInfo = await manager.consumers.info(STREAM, DURABLE);
    this.validateConsumer(consumerInfo.config);
    this.messages = await js.consumers.get(STREAM, DURABLE);
    void this.consume();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.connection?.drain();
  }

  private validateConsumer(config: {
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
  }): void {
    const backoff = [60, 120, 300, 300, 300, 300, 300, 300].map(
      (seconds) => seconds * 1_000_000_000,
    );
    if (
      JSON.stringify(config.filter_subjects ?? []) !==
        JSON.stringify(SUBJECTS) ||
      String(config.ack_policy).toLowerCase() !== 'explicit' ||
      String(config.deliver_policy).toLowerCase() !== 'all' ||
      String(config.replay_policy).toLowerCase() !== 'instant' ||
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
      const decoded: unknown = JSON.parse(
        new TextDecoder().decode(message.data),
      );
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
        permanent = true;
        throw new Error('invalid_envelope');
      }
      envelope = decoded as Envelope;
      eventType =
        typeof envelope.eventType === 'string' ? envelope.eventType : 'unknown';
      if (typeof envelope.eventId !== 'string' || !isUuid(envelope.eventId)) {
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
      await this.processEvent(message, envelope, eventType);
      message.ack();
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
      } else {
        const delay = Math.min(
          300_000,
          5_000 * 3 ** Math.max(delivered - 1, 0),
        );
        message.nak(delay);
      }
      this.logger.error(
        `Notification event ${eventType} failed: ${this.safeError(error)}`,
      );
    }
  }

  private async processEvent(
    message: JsMsg,
    event: Envelope,
    eventType: string,
  ): Promise<void> {
    const client = await this.pool!.connect();
    try {
      await client.query('BEGIN');
      const eventId = String(event.eventId).toLowerCase();
      const seen = await client.query(
        'SELECT 1 FROM public.consumer_processed_event WHERE consumer=$1 AND event_id=$2',
        [CONSUMER, eventId],
      );
      if (seen.rowCount) {
        await client.query('COMMIT');
        return;
      }
      const [recipient, kind] = recipientAndKind(event, eventType);
      if (typeof recipient === 'string' && recipient.length > 0 && kind) {
        await client.query(
          `INSERT INTO public.activity_notification
            (id, recipient_id, notification_type, payload, status, delivered_at, deduplication_key)
           VALUES ($1, $2, $3, $4::jsonb, 'DELIVERED', now(), $5)
           ON CONFLICT DO NOTHING`,
          [
            randomUUID(),
            recipient,
            kind,
            JSON.stringify({ eventType, eventId }),
            `event:${eventId}`,
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
    const eventId = isUuid(event.eventId)
      ? event.eventId.toLowerCase()
      : fallbackEventId(message.subject, message.info.streamSequence);
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
  const payload = event.payload ?? {};
  if (
    eventType.startsWith('geodata.entity.reviewed') ||
    eventType.startsWith('geodata.entity.status-changed')
  ) {
    const review = asRecord(payload.review);
    const provenance = asRecord(payload.provenance);
    return [
      payload.proposerId ?? review?.proposerId ?? provenance?.proposerId,
      'GEODATA_PROPOSAL_DECISION',
    ];
  }
  if (eventType.startsWith('identity.')) {
    const account = asRecord(payload.account);
    return [
      payload.accountId ?? account?.id ?? asRecord(event.aggregate)?.id,
      'ACCOUNT_SECURITY_EVENT',
    ];
  }
  return [null, null];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function fallbackEventId(subject: string, sequence: number): string {
  const hex = createHash('sha256')
    .update(`${subject}:${sequence}`)
    .digest('hex')
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
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
