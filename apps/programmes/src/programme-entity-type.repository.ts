import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';

export type EntityTypeRecord = Record<string, unknown> & { code: string };

@Injectable()
export class ProgrammeEntityTypeRepository {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async all(): Promise<Record<string, EntityTypeRecord>> {
    const client = await this.connect();
    try {
      return await this.listAll(client);
    } finally {
      client.release();
    }
  }

  async listAll(client: PoolClient): Promise<Record<string, EntityTypeRecord>> {
    const result = await client.query<{ payload: EntityTypeRecord }>(
      `SELECT payload FROM public.programme_entity_type
        ORDER BY code COLLATE "C"`,
    );
    return Object.fromEntries(
      result.rows.map(({ payload }) => [payload.code, payload]),
    );
  }

  async save(client: PoolClient, entityType: EntityTypeRecord): Promise<void> {
    await client.query(
      `INSERT INTO public.programme_entity_type (code, payload)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (code) DO UPDATE SET payload = EXCLUDED.payload`,
      [entityType.code, JSON.stringify(entityType)],
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
