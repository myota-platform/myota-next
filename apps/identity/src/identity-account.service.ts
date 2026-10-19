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
import { writeOutboxEvent, writeSecurityEvent } from '@app/platform/outbox.js';
import { IdentityAuthService } from './auth.service.js';
import { IdentityRoleService } from './identity-role.service.js';
import type { CreateAccountDto, RoleGrantDto } from './auth.dto.js';
import type { RoleDefinition } from './role-catalog.js';

interface RoleGrant {
  code: string;
  programmeSlug: string | null;
  jurisdiction: string | null;
  entityType: string | null;
  scopes: string[];
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
