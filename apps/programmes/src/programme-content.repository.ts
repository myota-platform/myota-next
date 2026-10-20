import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';

export type ProgrammeContentRecord = Record<string, unknown> & {
  id: string;
  programmeSlug: string;
  key: string;
  locale: string;
  status: string;
  reviewHistory: Record<string, unknown>[];
  updatedAt: string;
};

@Injectable()
export class ProgrammeContentRepository {
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
        const previous = await client.query<{ response: T }>(
          `SELECT response FROM public.idempotency_record
            WHERE service = 'programmes' AND key = $1`,
          [idempotencyKey],
        );
        if (previous.rows[0]) {
          await client.query('COMMIT');
          return previous.rows[0].response;
        }
      }
      const response = await operation(client);
      if (idempotencyKey) {
        await client.query(
          `INSERT INTO public.idempotency_record (service, key, response)
           VALUES ('programmes', $1, $2::jsonb)`,
          [idempotencyKey, JSON.stringify(response)],
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

  async lockRecord(client: PoolClient, id: string): Promise<void> {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('programme-content:' || $1, 0))",
      [id],
    );
  }

  async find(
    client: PoolClient,
    id: string,
  ): Promise<ProgrammeContentRecord | undefined> {
    const result = await client.query<{ payload: ProgrammeContentRecord }>(
      'SELECT payload FROM public.programme_content WHERE id=$1 FOR UPDATE',
      [id],
    );
    return result.rows[0]?.payload;
  }

  async get(id: string): Promise<ProgrammeContentRecord | undefined> {
    const client = await this.connect();
    try {
      const result = await client.query<{ payload: ProgrammeContentRecord }>(
        'SELECT payload FROM public.programme_content WHERE id=$1',
        [id],
      );
      return result.rows[0]?.payload;
    } finally {
      client.release();
    }
  }

  async save(client: PoolClient, record: ProgrammeContentRecord) {
    await client.query(
      `INSERT INTO public.programme_content
         (id, programme_slug, content_key, locale, status, updated_at, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         programme_slug=EXCLUDED.programme_slug,
         content_key=EXCLUDED.content_key,
         locale=EXCLUDED.locale,
         status=EXCLUDED.status,
         updated_at=EXCLUDED.updated_at,
         payload=EXCLUDED.payload`,
      [
        record.id,
        record.programmeSlug,
        record.key,
        record.locale,
        record.status,
        record.updatedAt,
        JSON.stringify(record),
      ],
    );
  }

  async recordEvent(
    client: PoolClient,
    eventType: string,
    contentId: string,
    payload: ProgrammeContentRecord,
  ) {
    const eventId = randomUUID();
    const occurredAt = new Date().toISOString();
    await client.query(
      `INSERT INTO public.outbox_event
         (event_id, event_type, producer, aggregate_type, aggregate_id,
          payload, occurred_at, correlation_id)
       VALUES ($1, $2, 'programmes', 'content', $3, $4::jsonb, $5, $6)`,
      [
        eventId,
        eventType,
        contentId,
        JSON.stringify(payload),
        occurredAt,
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
