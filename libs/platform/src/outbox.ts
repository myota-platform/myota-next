import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { stringifyJsonWithBigInts } from './json-bigint.js';

interface OutboxEventInput {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  producer?: string;
  correlationId?: string;
  occurredAt?: Date | string;
}

export async function writeOutboxEvent(
  client: PoolClient,
  event: OutboxEventInput,
): Promise<void> {
  await client.query(
    `INSERT INTO public.outbox_event
       (event_id, event_type, producer, aggregate_type, aggregate_id,
        payload, occurred_at, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb,
             COALESCE($7::timestamptz, clock_timestamp()), $8)`,
    [
      randomUUID(),
      event.eventType,
      event.producer ?? 'identity',
      event.aggregateType,
      event.aggregateId,
      stringifyJsonWithBigInts(event.payload),
      event.occurredAt ?? null,
      event.correlationId ?? randomUUID(),
    ],
  );
}

export async function writeSecurityEvent(
  client: PoolClient,
  eventType: string,
  payload: Record<string, unknown>,
  correlationId?: string,
): Promise<void> {
  const candidateAccountId = payload.accountId ?? payload.actorId;
  const accountId = isUuid(candidateAccountId) ? candidateAccountId : null;
  const aggregateId =
    typeof payload.accountId === 'string'
      ? payload.accountId
      : typeof payload.actorId === 'string'
        ? payload.actorId
        : 'system';
  const securityEvent = await client.query<{ occurred_at: string }>(
    `INSERT INTO public.security_event (id, account_id, event_type, payload, occurred_at)
     VALUES ($1, $2, $3, $4::jsonb, clock_timestamp())
     RETURNING to_char(occurred_at AT TIME ZONE 'UTC',
       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at`,
    [randomUUID(), accountId, eventType, stringifyJsonWithBigInts(payload)],
  );
  const occurredAt = securityEvent.rows[0].occurred_at;
  await writeOutboxEvent(client, {
    eventType,
    aggregateType: 'account',
    aggregateId,
    payload,
    correlationId,
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
