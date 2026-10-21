import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { parseJsonWithExactIntegers } from '@app/platform/json-exact.js';
import { parsePageTotal, type PageInteger } from '@app/platform/pagination.js';
import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import type { ProgrammeRecord } from './programme.types.js';

@Injectable()
export class ProgrammeRepository {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async listPage(
    pageSize: number,
    offset: PageInteger,
  ): Promise<{ items: ProgrammeRecord[]; total: PageInteger }> {
    const client = await this.connect();
    try {
      const result = await client.query<{
        items_text: string;
        total: string;
      }>(
        `WITH page AS (
           SELECT payload, record_order FROM public.programme_record
            ORDER BY record_order
            LIMIT $1 OFFSET $2
         )
         SELECT COALESCE(
                  (SELECT jsonb_agg(page.payload ORDER BY page.record_order)
                     FROM page),
                  '[]'::jsonb
                )::text AS items_text,
                (SELECT count(*)::text FROM public.programme_record) AS total`,
        [pageSize, offset],
      );
      const row = result.rows[0];
      return {
        items: row
          ? (parseJsonWithExactIntegers(row.items_text) as ProgrammeRecord[])
          : [],
        total: parsePageTotal(row?.total ?? '0'),
      };
    } finally {
      client.release();
    }
  }

  async listAll(client: PoolClient): Promise<ProgrammeRecord[]> {
    const result = await client.query<{ payload_text: string }>(
      `SELECT payload::text AS payload_text FROM public.programme_record ORDER BY record_order`,
    );
    return result.rows.map(
      (row) => parseJsonWithExactIntegers(row.payload_text) as ProgrammeRecord,
    );
  }

  async all(): Promise<ProgrammeRecord[]> {
    const client = await this.connect();
    try {
      const result = await client.query<{ payload_text: string }>(
        `SELECT payload::text AS payload_text FROM public.programme_record ORDER BY record_order`,
      );
      return result.rows.map(
        (row) =>
          parseJsonWithExactIntegers(row.payload_text) as ProgrammeRecord,
      );
    } finally {
      client.release();
    }
  }

  async get(slug: string): Promise<ProgrammeRecord | undefined> {
    const client = await this.connect();
    try {
      const result = await client.query<{ payload_text: string }>(
        'SELECT payload::text AS payload_text FROM public.programme_record WHERE slug=$1',
        [slug],
      );
      return result.rows[0]
        ? (parseJsonWithExactIntegers(
            result.rows[0].payload_text,
          ) as ProgrammeRecord)
        : undefined;
    } finally {
      client.release();
    }
  }

  async getInTransaction(
    client: PoolClient,
    slug: string,
  ): Promise<ProgrammeRecord | undefined> {
    const result = await client.query<{ payload_text: string }>(
      'SELECT payload::text AS payload_text FROM public.programme_record WHERE slug=$1 FOR UPDATE',
      [slug],
    );
    return result.rows[0]
      ? (parseJsonWithExactIntegers(
          result.rows[0].payload_text,
        ) as ProgrammeRecord)
      : undefined;
  }

  async create(
    client: PoolClient,
    slug: string,
    programme: ProgrammeRecord,
  ): Promise<void> {
    await client.query(
      `INSERT INTO public.programme_record
         (slug, status, created_at, updated_at, payload)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [
        slug,
        programme.status ?? 'ACTIVE',
        programme.createdAt ?? '',
        programme.updatedAt ?? '',
        stringifyJsonWithBigInts(programme),
      ],
    );
  }

  async save(client: PoolClient, programme: ProgrammeRecord): Promise<void> {
    await client.query(
      `INSERT INTO public.programme_record
         (slug, status, created_at, updated_at, payload)
       VALUES ($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT (slug) DO UPDATE SET
         status=EXCLUDED.status,
         created_at=EXCLUDED.created_at,
         updated_at=EXCLUDED.updated_at,
         payload=EXCLUDED.payload`,
      [
        programme.slug,
        programme.status ?? 'ACTIVE',
        programme.createdAt ?? '',
        programme.updatedAt ?? '',
        stringifyJsonWithBigInts(programme),
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
