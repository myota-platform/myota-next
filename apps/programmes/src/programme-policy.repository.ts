import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { ProgrammeMutationRepository } from './programme-mutation.repository.js';

export type ProgrammePolicyDraft = Record<string, unknown> & {
  id: string;
  programmeSlug: string;
  type: 'RULES' | 'AWARD';
  name: string;
  schema: Record<string, unknown>;
  status: string;
  reviewHistory: Record<string, unknown>[];
  updatedAt: string;
};

@Injectable()
export class ProgrammePolicyRepository {
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
    await this.mutations.lockAggregate(client, 'programme-policy-draft', id);
  }

  async find(
    client: PoolClient,
    id: string,
  ): Promise<ProgrammePolicyDraft | undefined> {
    const result = await client.query<{ payload: ProgrammePolicyDraft }>(
      'SELECT payload FROM public.programme_policy_draft WHERE id=$1 FOR UPDATE',
      [id],
    );
    return result.rows[0]?.payload;
  }

  async get(id: string): Promise<ProgrammePolicyDraft | undefined> {
    const client = await this.connect();
    try {
      const result = await client.query<{ payload: ProgrammePolicyDraft }>(
        'SELECT payload FROM public.programme_policy_draft WHERE id=$1',
        [id],
      );
      return result.rows[0]?.payload;
    } finally {
      client.release();
    }
  }

  async save(client: PoolClient, draft: ProgrammePolicyDraft): Promise<void> {
    await client.query(
      `INSERT INTO public.programme_policy_draft
         (id, programme_slug, draft_type, status, updated_at, payload)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         programme_slug=EXCLUDED.programme_slug,
         draft_type=EXCLUDED.draft_type,
         status=EXCLUDED.status,
         updated_at=EXCLUDED.updated_at,
         payload=EXCLUDED.payload`,
      [
        draft.id,
        draft.programmeSlug,
        draft.type,
        draft.status,
        draft.updatedAt,
        JSON.stringify(draft),
      ],
    );
  }

  async recordEvent(
    client: PoolClient,
    eventType: string,
    draftId: string,
    payload: ProgrammePolicyDraft,
  ): Promise<void> {
    await this.mutations.recordEvent(
      client,
      eventType,
      'policy_draft',
      draftId,
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
