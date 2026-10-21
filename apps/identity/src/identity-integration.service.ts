import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { writeSecurityEvent } from '@app/platform/outbox.js';
import { missingPythonTruthyFields } from '@app/platform/python-truthiness.js';
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
  ): Promise<Record<string, unknown>> {
    requireOidcFields(body, ['programmeSlug', 'issuer', 'clientId']);
    const actor = await this.auth.currentAccount(authorization);
    const scopes = new Set(actor.scopes as string[]);
    if (!scopes.has('*') && !scopes.has('identity.oidc.configure')) {
      throw new ForbiddenException('identity.oidc.configure scope is required');
    }

    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const id = randomUUID();
      const scopes =
        body.scopes === undefined
          ? ['openid', 'profile', 'email']
          : body.scopes;
      const mappingResult = await client.query<{
        id: string;
        programme_slug: string;
        issuer: string;
        client_id: string;
        scopes: string[] | null;
        enabled: boolean | null;
        created_at: Date;
        updated_at: Date;
      }>(
        `INSERT INTO public.identity_oidc_provider_mapping
               (id, programme_slug, issuer, client_id, scopes, enabled,
                created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6,
                     clock_timestamp(), clock_timestamp())
             RETURNING id, programme_slug, issuer, client_id, scopes, enabled,
                       created_at, updated_at`,
        [
          id,
          body.programmeSlug,
          body.issuer,
          body.clientId,
          scopes,
          body.enabled === undefined ? true : body.enabled,
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
      await writeSecurityEvent(
        client,
        'identity.oidc.mapping.updated.v1',
        mapping,
      );
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

function requireOidcFields(body: object, names: readonly string[]) {
  const missing = missingPythonTruthyFields(body, names);
  if (missing.length) {
    throw new BadRequestException(
      `missing required fields: ${missing.join(', ')}`,
    );
  }
}
