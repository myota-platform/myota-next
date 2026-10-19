import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { jetstream } from '@nats-io/jetstream';
import { connect } from '@nats-io/transport-node';
import type { Pool } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import {
  loadOutboxRegistry,
  OutboxContractError,
  routeOutboxEvent,
  type ClaimedOutboxEvent,
} from '@app/platform/outbox-routing.js';

const OWNER = process.env.OUTBOX_OWNER ?? '';
const WORKER = process.env.OUTBOX_WORKER ?? `${OWNER}-outbox`;
const MAX_ATTEMPTS = Math.max(1, Number(process.env.OUTBOX_MAX_ATTEMPTS ?? 12));
const MAX_MESSAGE_BYTES = Math.max(
  1024,
  Number(process.env.OUTBOX_MAX_MESSAGE_BYTES ?? 1_048_576),
);
const PUBLISH_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.OUTBOX_PUBLISH_TIMEOUT_MS ?? 10_000),
);
@Injectable()
export class OutboxWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxWorkerService.name);
  private stopping = false;
  private relay?: ReturnType<typeof jetstream>;
  private connection?: Awaited<ReturnType<typeof connect>>;

  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!['core', 'activity', 'geodata'].includes(OWNER))
      throw new Error('OUTBOX_OWNER must be core, activity, or geodata');
    if (!this.pool) throw new Error('OUTBOX_DATABASE_URL is required');
    const registry = await loadOutboxRegistry();
    this.connection = await connect({
      servers: process.env.NATS_URL ?? 'nats://nats:4222',
      name: WORKER,
      timeout: 5000,
      reconnect: true,
      maxReconnectAttempts: -1,
    });
    this.relay = jetstream(this.connection);
    void this.run(registry);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.connection?.drain();
  }

  private async run(
    registry: Awaited<ReturnType<typeof loadOutboxRegistry>>,
  ): Promise<void> {
    let dbRetryMs = 1000;
    while (!this.stopping) {
      try {
        const event = await this.claim();
        dbRetryMs = 1000;
        if (!event) {
          await this.pause(1000);
          continue;
        }
        await this.publish(event, registry);
      } catch (error) {
        this.logger.error(`Outbox polling failed: ${this.safeError(error)}`);
        await this.pause(dbRetryMs);
        dbRetryMs = Math.min(dbRetryMs * 2, 30_000);
      }
    }
  }

  private async claim(): Promise<ClaimedOutboxEvent | null> {
    const result = await this.pool!.query<ClaimedOutboxEvent>(
      `WITH next_event AS (
         SELECT event_id FROM public.outbox_event
         WHERE published_at IS NULL AND available_at <= now()
         ORDER BY occurred_at, event_id FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE public.outbox_event e SET attempts = e.attempts + 1
       FROM next_event n WHERE e.event_id = n.event_id
       RETURNING e.event_id AS "eventId", e.event_type AS "eventType",
         e.producer, e.aggregate_type AS "aggregateType", e.aggregate_id AS "aggregateId",
         e.payload, e.occurred_at AS "occurredAt", e.attempts, e.correlation_id AS "correlationId"`,
    );
    return result.rows[0] ?? null;
  }

  private async publish(
    event: ClaimedOutboxEvent,
    registry: Awaited<ReturnType<typeof loadOutboxRegistry>>,
  ): Promise<void> {
    let routed;
    let body: Uint8Array;
    try {
      routed = routeOutboxEvent(event, registry, OWNER);
      if (!routed.stream)
        throw new OutboxContractError('registered work stream is missing');
      body = new TextEncoder().encode(JSON.stringify(routed.envelope));
      if (body.byteLength > MAX_MESSAGE_BYTES)
        throw new OutboxContractError(
          `serialized event exceeds ${MAX_MESSAGE_BYTES} bytes`,
        );
    } catch (error) {
      await this.markFailed(event, error, true);
      return;
    }

    try {
      const ack = await this.relay!.publish(routed.subject, body, {
        msgID: event.eventId,
        timeout: PUBLISH_TIMEOUT_MS,
      });
      if (ack.stream !== routed.stream)
        throw new Error('JetStream acknowledged an unexpected stream');
      const client = await this.pool!.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'UPDATE public.outbox_event SET published_at = now(), last_error = NULL WHERE event_id = $1',
          [event.eventId],
        );
        await client.query(
          'UPDATE public.dead_letter_event SET resolved_at = now() WHERE event_id = $1 AND resolved_at IS NULL',
          [event.eventId],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      if (error instanceof OutboxContractError)
        await this.markFailed(event, error, true);
      else await this.markFailed(event, error, false);
    }
  }

  private async markFailed(
    event: ClaimedOutboxEvent,
    error: unknown,
    permanent: boolean,
  ): Promise<void> {
    const message = this.safeError(error);
    const dead = permanent || event.attempts >= MAX_ATTEMPTS;
    const client = await this.pool!.connect();
    try {
      await client.query('BEGIN');
      if (dead) {
        await client.query(
          `INSERT INTO public.dead_letter_event(event_id, event_type, payload, attempts, error, dead_lettered_at, resolved_at)
         VALUES ($1, $2, $3::jsonb, $4, $5, now(), NULL)
         ON CONFLICT (event_id) DO UPDATE SET event_type = EXCLUDED.event_type,
           payload = EXCLUDED.payload, attempts = EXCLUDED.attempts, error = EXCLUDED.error,
           dead_lettered_at = now(), resolved_at = NULL`,
          [
            event.eventId,
            event.eventType,
            JSON.stringify(event.payload),
            event.attempts,
            message,
          ],
        );
        await client.query(
          'UPDATE public.outbox_event SET published_at = now(), last_error = $1 WHERE event_id = $2',
          [`dead-lettered: ${message}`, event.eventId],
        );
        await client.query('COMMIT');
        this.logger.error(
          `Dead-lettered event ${event.eventId} (${event.eventType}): ${message}`,
        );
        return;
      }
      const base = Math.min(300, 2 ** Math.min(Math.max(1, event.attempts), 8));
      const delay = Math.min(
        300,
        Math.max(1, base * (0.8 + Math.random() * 0.4)),
      );
      await client.query(
        'UPDATE public.outbox_event SET available_at = now() + make_interval(secs => $1), last_error = $2 WHERE event_id = $3',
        [delay, message, event.eventId],
      );
      await client.query('COMMIT');
      this.logger.warn(
        `Scheduled retry for event ${event.eventId}: ${message}`,
      );
    } catch (failure) {
      await client.query('ROLLBACK');
      throw failure;
    } finally {
      client.release();
    }
  }

  private safeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/[\r\n\t]+/g, ' ').slice(0, 1000);
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
