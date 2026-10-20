import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

interface OutboxEventInput {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  producer?: string;
  correlationId?: string;
  occurredAt?: Date;
}

export async function writeOutboxEvent(
  client: PoolClient,
  event: OutboxEventInput,
): Promise<void> {
  await client.query(
    `INSERT INTO public.outbox_event
       (event_id, event_type, producer, aggregate_type, aggregate_id,
        payload, occurred_at, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [
      randomUUID(),
      event.eventType,
      event.producer ?? 'identity',
      event.aggregateType,
      event.aggregateId,
      JSON.stringify(event.payload),
      event.occurredAt ?? new Date(),
      event.correlationId ?? randomUUID(),
    ],
  );
}

export async function writeSecurityEvent(
  client: PoolClient,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const candidateAccountId = payload.accountId ?? payload.actorId;
  const accountId = isUuid(candidateAccountId) ? candidateAccountId : null;
  const aggregateId =
    typeof payload.accountId === 'string'
      ? payload.accountId
      : typeof payload.actorId === 'string'
        ? payload.actorId
        : 'system';
  const occurredAt = new Date();

  await client.query(
    `INSERT INTO public.security_event (id, account_id, event_type, payload, occurred_at)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [randomUUID(), accountId, eventType, JSON.stringify(payload), occurredAt],
  );
  await writeOutboxEvent(client, {
    eventType,
    aggregateType: 'account',
    aggregateId,
    payload,
    occurredAt,
  });
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}
