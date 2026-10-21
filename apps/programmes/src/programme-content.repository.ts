import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { parseJsonWithExactIntegers } from '@app/platform/json-exact.js';
import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import { ProgrammeMutationRepository } from './programme-mutation.repository.js';

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
    private readonly mutations: ProgrammeMutationRepository,
  ) {}

  async mutate<T>(
    idempotencyKey: string | undefined,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.mutations.mutate(idempotencyKey, operation);
  }

  async lockRecord(client: PoolClient, id: string): Promise<void> {
    await this.mutations.lockAggregate(client, 'programme-content', id);
  }

  async find(
    client: PoolClient,
    id: string,
  ): Promise<ProgrammeContentRecord | undefined> {
    const result = await client.query<{ payload_text: string }>(
      'SELECT payload::text AS payload_text FROM public.programme_content WHERE id=$1 FOR UPDATE',
      [id],
    );
    return result.rows[0]
      ? (parseJsonWithExactIntegers(
          result.rows[0].payload_text,
        ) as ProgrammeContentRecord)
      : undefined;
  }

  async get(id: string): Promise<ProgrammeContentRecord | undefined> {
    const client = await this.connect();
    try {
      const result = await client.query<{ payload_text: string }>(
        'SELECT payload::text AS payload_text FROM public.programme_content WHERE id=$1',
        [id],
      );
      return result.rows[0]
        ? (parseJsonWithExactIntegers(
            result.rows[0].payload_text,
          ) as ProgrammeContentRecord)
        : undefined;
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
        stringifyJsonWithBigInts(record),
      ],
    );
  }

  async recordEvent(
    client: PoolClient,
    eventType: string,
    contentId: string,
    payload: ProgrammeContentRecord,
  ) {
    await this.mutations.recordEvent(
      client,
      eventType,
      'content',
      contentId,
      payload,
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
