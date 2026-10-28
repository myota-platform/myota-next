import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
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
        items: ProgrammeRecord[];
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
                ) AS items,
                (SELECT count(*)::text FROM public.programme_record) AS total`,
        [pageSize, offset],
      );
      const row = result.rows[0];
      return {
        items: row?.items ?? [],
        total: parsePageTotal(row?.total ?? '0'),
      };
    } finally {
      client.release();
    }
  }

  async listAll(client: PoolClient): Promise<ProgrammeRecord[]> {
    const result = await client.query<{ payload: ProgrammeRecord }>(
      `SELECT payload FROM public.programme_record ORDER BY record_order`,
    );
    return result.rows.map((row) => row.payload);
  }

  async all(): Promise<ProgrammeRecord[]> {
    const client = await this.connect();
    try {
      const result = await client.query<{ payload: ProgrammeRecord }>(
        `SELECT payload FROM public.programme_record ORDER BY record_order`,
      );
      return result.rows.map((row) => row.payload);
    } finally {
      client.release();
    }
  }

  async get(slug: string): Promise<ProgrammeRecord | undefined> {
    const client = await this.connect();
    try {
      const result = await client.query<{ payload: ProgrammeRecord }>(
        'SELECT payload FROM public.programme_record WHERE slug=$1',
        [slug],
      );
      return result.rows[0]?.payload;
    } finally {
      client.release();
    }
  }

  async getInTransaction(
    client: PoolClient,
    slug: string,
  ): Promise<ProgrammeRecord | undefined> {
    const result = await client.query<{ payload: ProgrammeRecord }>(
      'SELECT payload FROM public.programme_record WHERE slug=$1 FOR UPDATE',
      [slug],
    );
    return result.rows[0]?.payload;
  }

  async identifierIsAssigned(
    client: PoolClient,
    identifier: string,
    excludingSlug?: string,
  ): Promise<boolean> {
    const result = await client.query(
      `SELECT 1 FROM public.programme_entity_identifier_reservation
        WHERE identifier=$1
          AND ($2::text IS NULL OR programme_slug <> $2)
        LIMIT 1`,
      [identifier, excludingSlug ?? null],
    );
    return result.rowCount !== 0;
  }

  async reserveIdentifier(
    client: PoolClient,
    slug: string,
    identifier: string,
  ): Promise<boolean> {
    await client.query(
      `INSERT INTO public.programme_entity_identifier_reservation
         (identifier, programme_slug)
       VALUES ($1, $2)
       ON CONFLICT (identifier) DO NOTHING`,
      [identifier, slug],
    );
    const result = await client.query<{ programme_slug: string }>(
      `SELECT programme_slug
         FROM public.programme_entity_identifier_reservation
        WHERE identifier=$1`,
      [identifier],
    );
    return result.rows[0]?.programme_slug === slug;
  }

  async create(
    client: PoolClient,
    slug: string,
    programme: ProgrammeRecord,
  ): Promise<void> {
    await client.query(
      `INSERT INTO public.programme_record
         (slug, status, created_at, updated_at, payload,
          programme_identifier)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [
        slug,
        programme.status ?? 'ACTIVE',
        programme.createdAt ?? '',
        programme.updatedAt ?? '',
        stringifyJsonWithBigInts(programme),
        programme.entityNumbering?.identifier ?? null,
      ],
    );
  }

  async save(client: PoolClient, programme: ProgrammeRecord): Promise<void> {
    await client.query(
      `INSERT INTO public.programme_record
         (slug, status, created_at, updated_at, payload,
          programme_identifier)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)
       ON CONFLICT (slug) DO UPDATE SET
         status=EXCLUDED.status,
         created_at=EXCLUDED.created_at,
         updated_at=EXCLUDED.updated_at,
         payload=EXCLUDED.payload,
         programme_identifier=EXCLUDED.programme_identifier`,
      [
        programme.slug,
        programme.status ?? 'ACTIVE',
        programme.createdAt ?? '',
        programme.updatedAt ?? '',
        stringifyJsonWithBigInts(programme),
        programme.entityNumbering?.identifier ?? null,
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
