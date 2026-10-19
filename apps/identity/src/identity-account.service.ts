import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { writeOutboxEvent, writeSecurityEvent } from '@app/platform/outbox.js';
import { IdentityAuthService } from './auth.service.js';
import { IdentityRoleService } from './identity-role.service.js';
import type { CreateAccountDto, RoleGrantDto } from './auth.dto.js';
import type { RoleDefinition } from './role-catalog.js';
import { DEFAULT_ROLE_SCOPES } from './role-catalog.js';

interface RoleGrant {
  code: string;
  programmeSlug: string | null;
  jurisdiction: string | null;
  entityType: string | null;
  scopes: string[];
}

interface AccountRecord {
  id: string;
  display_name: string;
  email: string | null;
  participation_type: string;
  status: string;
  website_url: string | null;
  biography_markdown: string | null;
  profile_image_id: string | null;
  profile_image_media_type: string | null;
  profile_image_updated_at: Date | null;
  primary_callsign_id: string | null;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class IdentityAccountService {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
    private readonly auth: IdentityAuthService,
    private readonly roleService: IdentityRoleService,
  ) {}

  async create(
    authorization: string,
    body: CreateAccountDto,
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    const actor = await this.auth.currentAccount(authorization);
    const actorScopes = new Set(actor.scopes as string[]);
    if (!actorScopes.has('*') && !actorScopes.has('identity.accounts.create')) {
      throw new ForbiddenException(
        'identity.accounts.create scope is required',
      );
    }
    if ('password' in body) {
      throw new BadRequestException(
        'passwords cannot be set during account creation; use the invitation setup flow',
      );
    }
    const normalizedEmail = body.email.trim().toLowerCase();
    if (!normalizedEmail.includes('@')) {
      throw new BadRequestException('email must be a valid address');
    }

    const additionalAssignments = body.roles ?? [];
    let roleDefinitions: RoleDefinition[] = [];
    if (additionalAssignments.length > 0) {
      if (!actorScopes.has('*') && !actorScopes.has('identity.roles.assign')) {
        throw new ForbiddenException('identity.roles.assign scope is required');
      }
      const catalogue = await this.roleService.listAdminRoles(authorization);
      roleDefinitions = catalogue.items as RoleDefinition[];
    }
    const grants = this.validateRoleGrants(
      additionalAssignments,
      actorScopes,
      roleDefinitions,
    );

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

      const duplicate = await client.query(
        `SELECT 1 FROM public.account
          WHERE lower(btrim(email::text)) = $1`,
        [normalizedEmail],
      );
      if (duplicate.rowCount) {
        throw new BadRequestException('email already exists');
      }

      const accountId = randomUUID();
      const accountResult = await client.query<{
        created_at: Date;
        updated_at: Date;
      }>(
        `INSERT INTO public.account
           (id, display_name, email, identity_email_key, participation_type, status)
         VALUES ($1, $2, $3, $3, $4, 'PENDING_SETUP')
         RETURNING created_at, updated_at`,
        [accountId, body.displayName, normalizedEmail, body.participationType],
      );

      const callsigns: Record<string, unknown>[] = [];
      let primaryCallsignId: string | null = null;
      let callsignValue: string | undefined;
      if (body.callsign) {
        callsignValue = body.callsign.trim().toUpperCase();
        if (!callsignValue) {
          throw new BadRequestException('callsign cannot be empty');
        }
      }
      if (callsignValue) {
        const callsignId = randomUUID();
        await client.query(
          `INSERT INTO public.callsign
             (id, account_id, value, lifecycle_status, verification_source)
           VALUES ($1, $2, $3, 'UNVERIFIED', 'self-asserted')`,
          [callsignId, accountId, callsignValue],
        );
        const createdAt = new Date();
        const callsign = {
          id: callsignId,
          value: callsignValue,
          status: 'UNVERIFIED',
          source: 'self-asserted',
          verificationSource: null,
          verifiedAt: null,
          validFrom: null,
          validTo: null,
          evidenceIds: [],
          createdAt,
          updatedAt: createdAt,
        };
        callsigns.push(callsign);
        if (body.participationType === 'OPERATOR') {
          primaryCallsignId = callsignId;
          await client.query(
            `INSERT INTO public.account_primary_callsign (account_id, callsign_id)
             VALUES ($1, $2)`,
            [accountId, callsignId],
          );
        }
        await writeOutboxEvent(client, {
          eventType: 'identity.callsign.added.v1',
          aggregateType: 'callsign',
          aggregateId: callsignId,
          payload: { accountId, ...callsign },
        });
      }

      const account = {
        id: accountId,
        displayName: body.displayName,
        email: normalizedEmail,
        participationType: body.participationType,
        status: 'PENDING_SETUP',
        websiteUrl: null,
        biographyMarkdown: null,
        profileImage: null,
        callsigns,
        primaryCallsignId,
        createdAt: accountResult.rows[0].created_at,
        updatedAt: accountResult.rows[0].updated_at,
      };
      await writeOutboxEvent(client, {
        eventType: 'identity.account.created.v1',
        aggregateType: 'account',
        aggregateId: accountId,
        payload: { account, actorId: actor.id },
      });

      const assignments: RoleGrant[] = [
        {
          code: 'PARTICIPANT',
          programmeSlug: null,
          jurisdiction: null,
          entityType: null,
          scopes: [],
        },
        ...grants,
      ];
      const createdRoles = await this.assignRoles(
        client,
        accountId,
        assignments,
      );
      if (additionalAssignments.length > 0) {
        await writeSecurityEvent(client, 'identity.roles.replaced.v1', {
          accountId,
          roles: createdRoles,
          actorId: actor.id,
        });
      } else {
        await writeSecurityEvent(client, 'identity.role.assigned.v1', {
          ...createdRoles[0],
          actorId: actor.id,
        });
      }

      const response = { ...account, roles: createdRoles };
      if (idempotencyKey) {
        await client.query(
          `INSERT INTO public.idempotency_record (service, key, response)
           VALUES ('identity', $1, $2::jsonb)`,
          [idempotencyKey, JSON.stringify(response)],
        );
      }
      await client.query('COMMIT');
      return response;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (isUniqueViolation(error)) {
        throw new BadRequestException('email already exists');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async getAccount(
    authorization: string,
    accountId: string,
  ): Promise<Record<string, unknown>> {
    await this.authorizeAccountTarget(authorization, accountId);
    const client = await this.connect();
    try {
      const result = await client.query<AccountRecord>(
        `SELECT a.id, a.display_name, a.email::text AS email,
                a.participation_type, a.status, a.created_at, a.updated_at,
                p.website_url, p.biography_markdown, p.profile_image_id,
                p.profile_image_media_type, p.profile_image_updated_at,
                primary_call.callsign_id AS primary_callsign_id
           FROM public.account a
           LEFT JOIN public.identity_account_profile p ON p.account_id = a.id
           LEFT JOIN public.account_primary_callsign primary_call
             ON primary_call.account_id = a.id
          WHERE a.id = $1`,
        [accountId],
      );
      const account = result.rows[0];
      if (!account) throw new NotFoundException('account not found');
      const callsigns = await client.query(
        `SELECT c.id, c.value, c.lifecycle_status AS status,
                c.verification_source AS source,
                c.verification_source AS "verificationSource",
                c.verified_at AS "verifiedAt", c.valid_from AS "validFrom",
                c.valid_to AS "validTo",
                coalesce(array_agg(e.id) FILTER (WHERE e.id IS NOT NULL), '{}')
                  AS "evidenceIds"
           FROM public.callsign c
           LEFT JOIN public.callsign_evidence e ON e.callsign_id = c.id
          WHERE c.account_id = $1
          GROUP BY c.id
          ORDER BY c.valid_from NULLS FIRST, c.value`,
        [accountId],
      );
      return {
        id: account.id,
        displayName: account.display_name,
        email: account.email,
        participationType: account.participation_type,
        status: account.status,
        websiteUrl: account.website_url,
        biographyMarkdown: account.biography_markdown,
        profileImage: account.profile_image_id
          ? {
              id: account.profile_image_id,
              contentType: account.profile_image_media_type,
              width: 512,
              height: 512,
              updatedAt: account.profile_image_updated_at,
            }
          : null,
        callsigns: callsigns.rows,
        primaryCallsignId: account.primary_callsign_id,
        createdAt: account.created_at,
        updatedAt: account.updated_at,
      };
    } finally {
      client.release();
    }
  }

  async listAccountRoles(
    authorization: string,
    accountId: string,
  ): Promise<Record<string, unknown>[]> {
    await this.authorizeAccountTarget(authorization, accountId);
    const client = await this.connect();
    try {
      const result = await client.query<{
        accountId: string;
        id: string;
        role: string;
        programmeId: string | null;
        programmeSlug: string | null;
        jurisdictionId: string | null;
        jurisdiction: string | null;
        entityType: string | null;
        scopes: string[];
        createdAt: Date;
        validTo: Date | null;
      }>(
        `SELECT ar.account_id AS "accountId", ar.id, ar.role_code AS role,
                ar.programme_id AS "programmeId",
                coalesce(ar.programme_slug, p.slug) AS "programmeSlug",
                ar.jurisdiction_id AS "jurisdictionId",
                coalesce(ar.jurisdiction_code, j.code) AS jurisdiction,
                ar.entity_type_code AS "entityType",
                coalesce(rd.scopes, ARRAY(SELECT jsonb_array_elements_text(ar.scopes))) AS scopes,
                ar.created_at AS "createdAt", ar.valid_to AS "validTo"
           FROM public.account_role ar
           LEFT JOIN public.identity_role_definition rd ON rd.role_code = ar.role_code
           LEFT JOIN public.programme p ON p.id = ar.programme_id
           LEFT JOIN public.jurisdiction j ON j.id = ar.jurisdiction_id
          WHERE ar.account_id = $1 AND (ar.valid_to IS NULL OR ar.valid_to > now())
          ORDER BY ar.created_at, ar.id`,
        [accountId],
      );
      return result.rows.map((role) => ({
        ...role,
        scopes: DEFAULT_ROLE_SCOPES[role.role] ?? role.scopes,
      }));
    } finally {
      client.release();
    }
  }

  private async authorizeAccountTarget(
    authorization: string,
    accountId: string,
  ) {
    const caller = await this.auth.currentAccount(authorization);
    const scopes = new Set(caller.scopes as string[]);
    if (caller.id !== accountId && !scopes.has('*')) {
      throw new ForbiddenException('account scope is missing');
    }
  }

  private validateRoleGrants(
    requested: RoleGrantDto[],
    actorScopes: Set<string>,
    definitions: RoleDefinition[],
  ): RoleGrant[] {
    const actorPrivileges = new Set(actorScopes);
    actorPrivileges.delete('identity.me');
    return requested.map((assignment) => {
      const code = (assignment.code || assignment.role || '').toUpperCase();
      const definition = definitions.find((role) => role.code === code);
      if (!definition) throw new BadRequestException(`unknown role: ${code}`);
      const targetScopes = definition.scopes;
      const mayGrant =
        !targetScopes.includes('*') &&
        (actorPrivileges.has('*') ||
          (targetScopes.every((scope) => actorPrivileges.has(scope)) &&
            targetScopes.length < actorPrivileges.size));
      if (!mayGrant) {
        throw new ForbiddenException(
          'actors may grant only roles strictly below their authority',
        );
      }
      return {
        code,
        programmeSlug: assignment.programmeSlug ?? null,
        jurisdiction: assignment.jurisdiction ?? null,
        entityType: assignment.entityType ?? null,
        scopes: targetScopes,
      };
    });
  }

  private async assignRoles(
    client: PoolClient,
    accountId: string,
    assignments: RoleGrant[],
  ) {
    const result: Record<string, unknown>[] = [];
    const createdAt = new Date();
    for (const assignment of assignments) {
      const id = randomUUID();
      await client.query(
        `INSERT INTO public.account_role
           (id, account_id, programme_id, role_code, jurisdiction_id,
            entity_type_code, scopes, programme_slug, jurisdiction_code, created_at)
         VALUES ($1, $2, (SELECT id FROM public.programme WHERE slug = $3), $4,
                 NULL, $5, $6::jsonb, $3, $7, $8)`,
        [
          id,
          accountId,
          assignment.programmeSlug,
          assignment.code,
          assignment.entityType,
          JSON.stringify(assignment.scopes),
          assignment.jurisdiction,
          createdAt,
        ],
      );
      result.push({
        id,
        accountId,
        role: assignment.code,
        programmeSlug: assignment.programmeSlug,
        jurisdiction: assignment.jurisdiction,
        entityType: assignment.entityType,
        scopes: assignment.scopes,
        createdAt,
        validTo: null,
      });
    }
    return result;
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

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}
