import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import { parseJsonWithExactIntegers } from '@app/platform/json-exact.js';

@Injectable()
export class ProgrammeMutationRepository {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async mutate<T>(
    idempotencyKey: string | undefined,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      if (idempotencyKey) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('programmes:' || $1, 0))",
          [idempotencyKey],
        );
        const previous = await client.query<{ response_text: string }>(
          `SELECT response::text AS response_text FROM public.idempotency_record
            WHERE service = 'programmes' AND key = $1`,
          [idempotencyKey],
        );
        if (previous.rows[0]) {
          await client.query('COMMIT');
          return parseJsonWithExactIntegers(
            previous.rows[0].response_text,
          ) as T;
        }
      }
      const response = await operation(client);
      if (idempotencyKey) {
        await client.query(
          `INSERT INTO public.idempotency_record (service, key, response)
           VALUES ('programmes', $1, $2::jsonb)`,
          [idempotencyKey, stringifyJsonWithBigInts(response)],
        );
      }
      await client.query('COMMIT');
      return response;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async lockAggregate(
    client: PoolClient,
    aggregateType: string,
    aggregateId: string,
  ): Promise<void> {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))",
      [aggregateType, aggregateId],
    );
  }

  async recordEvent(
    client: PoolClient,
    eventType: string,
    aggregateType: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO public.outbox_event
         (event_id, event_type, producer, aggregate_type, aggregate_id,
          payload, occurred_at, correlation_id)
       VALUES ($1, $2, 'programmes', $3, $4, $5::jsonb, $6, $7)`,
      [
        randomUUID(),
        eventType,
        aggregateType,
        aggregateId,
        stringifyJsonWithBigInts(payload),
        new Date().toISOString(),
        randomUUID(),
      ],
    );
  }

  private async connect(): Promise<PoolClient> {
    if (!this.pool) {
      throw new ServiceUnavailableException(
        'Programme database is not configured',
      );
    }
    try {
      return await this.pool.connect();
    } catch {
      throw new ServiceUnavailableException(
        'Programme database is unavailable',
      );
    }
  }
}
