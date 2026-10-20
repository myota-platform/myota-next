import {
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { writeSecurityEvent } from '@app/platform/outbox.js';
import type { IdentityAuthService } from './auth.service.js';
import type { OidcProviderMappingDto } from './auth.dto.js';

@Injectable()
export class IdentityIntegrationService {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
    private readonly auth: IdentityAuthService,
  ) {}

  async saveOidcMapping(
    authorization: string,
    body: OidcProviderMappingDto,
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    const actor = await this.auth.currentAccount(authorization);
    const scopes = new Set(actor.scopes as string[]);
    if (!scopes.has('*') && !scopes.has('identity.oidc.configure')) {
      throw new ForbiddenException('identity.oidc.configure scope is required');
    }

    const client = await this.connect();
    try {
      await client.query('BEGIN');
      if (idempotencyKey) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('identity:' || $1, 0))",
          [idempotencyKey],
        );
        const previous = await client.query<{
          response: Record<string, unknown>;
        }>(
          `SELECT response FROM public.idempotency_record
            WHERE service = 'identity' AND key = $1`,
          [idempotencyKey],
        );
        if (previous.rows[0]) {
          await client.query('COMMIT');
          return previous.rows[0].response;
        }
      }

      const id = randomUUID();
      const scopes = body.scopes ?? ['openid', 'profile', 'email'];
      const mappingResult = await client.query<{
        id: string;
        programme_slug: string;
        issuer: string;
        client_id: string;
        scopes: string[];
        enabled: boolean;
        created_at: Date;
        updated_at: Date;
      }>(
        `INSERT INTO public.identity_oidc_provider_mapping
               (id, programme_slug, issuer, client_id, scopes, enabled)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, programme_slug, issuer, client_id, scopes, enabled,
                       created_at, updated_at`,
        [
          id,
          body.programmeSlug.trim(),
          body.issuer.trim(),
          body.clientId.trim(),
          scopes,
          body.enabled ?? true,
        ],
      );
      const row = mappingResult.rows[0];
      const mapping = {
        id: row.id,
        programmeSlug: row.programme_slug,
        issuer: row.issuer,
        clientId: row.client_id,
        scopes: row.scopes,
        enabled: row.enabled,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
      await writeSecurityEvent(client, 'identity.oidc.mapping.updated.v1', {
        ...mapping,
        actorId: actor.id,
      });
      if (idempotencyKey) {
        await client.query(
          `INSERT INTO public.idempotency_record (service, key, response)
           VALUES ('identity', $1, $2::jsonb)`,
          [idempotencyKey, JSON.stringify(mapping)],
        );
      }
      await client.query('COMMIT');
      return mapping;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async connect(): Promise<PoolClient> {
    if (!this.pool) {
      throw new ServiceUnavailableException(
        'Identity database is not configured',
      );
    }
    try {
      return await this.pool.connect();
    } catch {
      throw new ServiceUnavailableException('Identity database is unavailable');
    }
  }
}
