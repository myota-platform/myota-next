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
import { parsePageInteger } from '@app/platform/pagination.js';
import { writeOutboxEvent, writeSecurityEvent } from '@app/platform/outbox.js';
import { unicodeCaseFold } from '@app/platform/unicode-casefold.js';
import {
  IdentityAuthService,
  hashPassword,
  validateWebsiteUrl,
} from './auth.service.js';
import { IdentityRoleService } from './identity-role.service.js';
import { IdentityProfileImageService } from './identity-profile-image.service.js';
import type {
  AddCallsignDto,
  CallsignEvidenceDto,
  CreateAccountDto,
  RetireCallsignDto,
  RoleGrantDto,
  SetPrimaryCallsignDto,
  UpdateAccountDto,
  VerifyCallsignDto,
} from './auth.dto.js';
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
    private readonly profileImages: IdentityProfileImageService,
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
    const normalizedEmail = unicodeCaseFold(body.email.trim());
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
          WHERE identity_email_key = $1`,
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
             (id, account_id, value, lifecycle_status, source,
              verification_source, created_at, updated_at)
           VALUES ($1, $2, $3, 'UNVERIFIED', 'self-asserted', NULL, now(), now())`,
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

  async listSecurityEvents(
    authorization: string,
    query: { page?: string; pageSize?: string },
  ): Promise<Record<string, unknown>> {
    const actor = await this.auth.currentAccount(authorization);
    const scopes = new Set(actor.scopes as string[]);
    if (!scopes.has('*') && !scopes.has('identity.admin')) {
      throw new ForbiddenException('identity.admin scope is required');
    }
    const page = parsePageInteger(query.page, 1);
    const pageSize = Math.min(100, parsePageInteger(query.pageSize, 50));
    const client = await this.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const countResult = await client.query<{ total: string }>(
        'SELECT count(*)::text AS total FROM public.security_event',
      );
      const eventsResult = await client.query<{
        id: string;
        event_type: string;
        payload: Record<string, unknown>;
        occurred_at: Date;
      }>(
        `SELECT id, event_type, payload, occurred_at
             FROM public.security_event
            ORDER BY occurred_at DESC, id DESC
            LIMIT $1 OFFSET $2`,
        [pageSize, (page - 1) * pageSize],
      );
      await client.query('COMMIT');
      const total = Number(countResult.rows[0]?.total ?? 0);
      return {
        items: eventsResult.rows.map((event) => ({
          id: event.id,
          eventType: event.event_type,
          occurredAt: event.occurred_at,
          payload: event.payload,
        })),
        page,
        pageSize,
        total,
        nextPage: page * pageSize < total ? page + 1 : null,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
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
                c.source,
                c.verification_source AS "verificationSource",
                c.verified_at AS "verifiedAt", c.valid_from AS "validFrom",
                c.valid_to AS "validTo", c.created_at AS "createdAt",
                c.updated_at AS "updatedAt",
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

  async addCallsign(
    authorization: string,
    accountId: string,
    body: AddCallsignDto,
    idempotencyKey?: string,
  ) {
    await this.authorizeAccountTarget(authorization, accountId);
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const previous = await this.readIdempotentResult(client, idempotencyKey);
      if (previous) {
        await client.query('COMMIT');
        return previous;
      }
      const accountResult = await client.query<{
        participation_type: string;
        primary_callsign_id: string | null;
      }>(
        `SELECT a.participation_type, primary_call.callsign_id AS primary_callsign_id
           FROM public.account a
           LEFT JOIN public.account_primary_callsign primary_call
             ON primary_call.account_id = a.id
          WHERE a.id = $1 FOR UPDATE OF a`,
        [accountId],
      );
      const account = accountResult.rows[0];
      if (!account) throw new NotFoundException('account not found');
      const value = body.callsign.trim().toUpperCase();
      if (!value) throw new BadRequestException('callsign cannot be empty');
      const duplicate = await client.query(
        `SELECT 1 FROM public.callsign
          WHERE account_id = $1 AND value = $2 AND lifecycle_status <> 'RETIRED'`,
        [accountId, value],
      );
      if (duplicate.rowCount) {
        throw new BadRequestException('callsign already exists on account');
      }
      const id = randomUUID();
      const status = body.status ?? 'UNVERIFIED';
      const source = body.source ?? 'self-asserted';
      const createdAt = new Date();
      const verifiedAt = status === 'VERIFIED' ? createdAt : null;
      await client.query(
        `INSERT INTO public.callsign
           (id, account_id, value, lifecycle_status, source, verification_source,
            verified_at, valid_from, valid_to, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
        [
          id,
          accountId,
          value,
          status,
          source,
          status === 'VERIFIED' ? source : null,
          verifiedAt,
          body.validFrom ?? null,
          body.validTo ?? null,
          createdAt,
        ],
      );
      if (
        !account.primary_callsign_id &&
        account.participation_type === 'OPERATOR'
      ) {
        await client.query(
          `INSERT INTO public.account_primary_callsign (account_id, callsign_id)
           VALUES ($1, $2)`,
          [accountId, id],
        );
      }
      await client.query(
        'UPDATE public.account SET updated_at = now() WHERE id = $1',
        [accountId],
      );
      const callsign = {
        id,
        value,
        status,
        source,
        verificationSource: status === 'VERIFIED' ? source : null,
        verifiedAt,
        validFrom: body.validFrom ?? null,
        validTo: body.validTo ?? null,
        evidenceIds: [],
        createdAt,
        updatedAt: createdAt,
      };
      await writeOutboxEvent(client, {
        eventType: 'identity.callsign.added.v1',
        aggregateType: 'callsign',
        aggregateId: id,
        payload: { accountId, ...callsign },
      });
      const response = {
        account: await this.readAccountView(client, accountId),
        callsign,
      };
      await this.storeIdempotentResult(client, idempotencyKey, response);
      await client.query('COMMIT');
      return response;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async setPrimaryCallsign(
    authorization: string,
    accountId: string,
    body: SetPrimaryCallsignDto,
    idempotencyKey?: string,
  ) {
    await this.authorizeAccountTarget(authorization, accountId);
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const previous = await this.readIdempotentResult(client, idempotencyKey);
      if (previous) {
        await client.query('COMMIT');
        return previous;
      }
      const account = await client.query(
        'SELECT id FROM public.account WHERE id = $1 FOR UPDATE',
        [accountId],
      );
      if (!account.rowCount) throw new NotFoundException('account not found');
      const callsign = await client.query(
        `SELECT 1 FROM public.callsign
          WHERE id = $1 AND account_id = $2 AND lifecycle_status <> 'RETIRED'`,
        [body.callsignId, accountId],
      );
      if (!callsign.rowCount) {
        throw new BadRequestException(
          'callsignId is not an active callsign on this account',
        );
      }
      await client.query(
        `INSERT INTO public.account_primary_callsign (account_id, callsign_id)
         VALUES ($1, $2)
         ON CONFLICT (account_id) DO UPDATE SET callsign_id = EXCLUDED.callsign_id`,
        [accountId, body.callsignId],
      );
      await client.query(
        'UPDATE public.account SET updated_at = now() WHERE id = $1',
        [accountId],
      );
      await writeOutboxEvent(client, {
        eventType: 'identity.callsign.primary-changed.v1',
        aggregateType: 'account',
        aggregateId: accountId,
        payload: { callsignId: body.callsignId },
      });
      const response = await this.readAccountView(client, accountId);
      await this.storeIdempotentResult(client, idempotencyKey, response);
      await client.query('COMMIT');
      return response;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async submitCallsignEvidence(
    authorization: string,
    accountId: string,
    callsignId: string,
    body: CallsignEvidenceDto,
  ) {
    const actor = await this.auth.currentAccount(authorization);
    const actorScopes = new Set(actor.scopes as string[]);
    if (actor.id !== accountId && !actorScopes.has('*')) {
      throw new ForbiddenException('account scope is missing');
    }
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const callsign = await client.query(
        `SELECT id FROM public.callsign WHERE id = $1 AND account_id = $2 FOR UPDATE`,
        [callsignId, accountId],
      );
      if (!callsign.rowCount) throw new NotFoundException('callsign not found');
      const evidenceId = randomUUID();
      const evidence = {
        id: evidenceId,
        callsignId,
        accountId,
        evidenceType: body.evidenceType,
        source: body.source,
        checksum: body.checksum ?? null,
        metadata: body.metadata ?? {},
        submittedAt: new Date(),
        status: 'PENDING',
      };
      await client.query(
        `INSERT INTO public.callsign_evidence
           (id, callsign_id, submitted_by, evidence_type, source,
            checksum, metadata, status, submitted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'PENDING', $8)`,
        [
          evidenceId,
          callsignId,
          actor.id,
          body.evidenceType,
          body.source,
          body.checksum ?? null,
          JSON.stringify(body.metadata ?? {}),
          evidence.submittedAt,
        ],
      );
      await writeOutboxEvent(client, {
        eventType: 'identity.callsign.evidence-submitted.v1',
        aggregateType: 'callsign',
        aggregateId: callsignId,
        payload: evidence,
      });
      await client.query('COMMIT');
      return evidence;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async verifyCallsign(
    authorization: string,
    accountId: string,
    callsignId: string,
    body: VerifyCallsignDto,
  ) {
    const actor = await this.auth.currentAccount(authorization);
    const scopes = new Set(actor.scopes as string[]);
    if (!scopes.has('*') && !scopes.has('callsign.verify')) {
      throw new ForbiddenException('callsign.verify scope is required');
    }
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const callsignResult = await client.query<{
        id: string;
        value: string;
        source: string | null;
        valid_from: Date | null;
        valid_to: Date | null;
      }>(
        `SELECT id, value, source, valid_from, valid_to
           FROM public.callsign WHERE id = $1 AND account_id = $2 FOR UPDATE`,
        [callsignId, accountId],
      );
      const current = callsignResult.rows[0];
      if (!current) throw new NotFoundException('callsign not found');
      const evidence = await client.query(
        'SELECT id FROM public.callsign_evidence WHERE callsign_id = $1',
        [callsignId],
      );
      if (!evidence.rowCount) {
        throw new BadRequestException(
          'at least one evidence record is required',
        );
      }
      const verifiedAt = new Date();
      const verificationSource = body.source ?? 'manual-review';
      await client.query(
        `UPDATE public.callsign
            SET lifecycle_status = 'VERIFIED', verification_source = $2,
                verified_at = $3, updated_at = $3
          WHERE id = $1`,
        [callsignId, verificationSource, verifiedAt],
      );
      await client.query(
        `UPDATE public.callsign_evidence
            SET status = 'ACCEPTED', reviewed_at = $2
          WHERE callsign_id = $1`,
        [callsignId, verifiedAt],
      );
      const result = {
        id: callsignId,
        value: current.value,
        status: 'VERIFIED',
        source: current.source,
        verificationSource,
        verifiedAt,
        validFrom: current.valid_from,
        validTo: current.valid_to,
        evidenceIds: evidence.rows.map((item) => item.id),
        updatedAt: verifiedAt,
      };
      await writeOutboxEvent(client, {
        eventType: 'identity.callsign.verified.v1',
        aggregateType: 'callsign',
        aggregateId: callsignId,
        payload: result,
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async retireCallsign(
    authorization: string,
    accountId: string,
    callsignId: string,
    body: RetireCallsignDto,
  ) {
    await this.authorizeAccountTarget(authorization, accountId);
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const account = await client.query(
        `SELECT primary_call.callsign_id AS primary_callsign_id
           FROM public.account a
           LEFT JOIN public.account_primary_callsign primary_call
             ON primary_call.account_id = a.id
          WHERE a.id = $1 FOR UPDATE OF a`,
        [accountId],
      );
      if (!account.rowCount) throw new NotFoundException('account not found');
      const currentResult = await client.query<{
        id: string;
        value: string;
        source: string | null;
        verification_source: string | null;
        verified_at: Date | null;
        valid_from: Date | null;
        valid_to: Date | null;
      }>(
        `SELECT id, value, source, verification_source, verified_at,
                valid_from, valid_to
           FROM public.callsign WHERE id = $1 AND account_id = $2 FOR UPDATE`,
        [callsignId, accountId],
      );
      const current = currentResult.rows[0];
      if (!current) throw new NotFoundException('callsign not found');
      if (account.rows[0].primary_callsign_id === callsignId) {
        const replacement = body.newPrimaryCallsignId;
        if (!replacement) {
          throw new BadRequestException(
            'retiring the primary callsign requires an active replacement',
          );
        }
        const active = await client.query(
          `SELECT 1 FROM public.callsign
            WHERE id = $1 AND account_id = $2 AND lifecycle_status <> 'RETIRED'`,
          [replacement, accountId],
        );
        if (!active.rowCount) {
          throw new BadRequestException(
            'retiring the primary callsign requires an active replacement',
          );
        }
        await client.query(
          `UPDATE public.account_primary_callsign SET callsign_id = $2
            WHERE account_id = $1`,
          [accountId, replacement],
        );
      }
      const validTo = body.validTo ? new Date(body.validTo) : new Date();
      await client.query(
        `UPDATE public.callsign
            SET lifecycle_status = 'RETIRED', valid_to = $2, updated_at = now()
          WHERE id = $1`,
        [callsignId, validTo],
      );
      await client.query(
        'UPDATE public.account SET updated_at = now() WHERE id = $1',
        [accountId],
      );
      const result = {
        id: callsignId,
        value: current.value,
        status: 'RETIRED',
        source: current.source,
        verificationSource: current.verification_source,
        verifiedAt: current.verified_at,
        validFrom: current.valid_from,
        validTo,
        updatedAt: new Date(),
      };
      await writeOutboxEvent(client, {
        eventType: 'identity.callsign.retired.v1',
        aggregateType: 'callsign',
        aggregateId: callsignId,
        payload: result,
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async updateAccount(
    authorization: string,
    accountId: string,
    body: UpdateAccountDto,
  ): Promise<Record<string, unknown>> {
    const actor = await this.auth.currentAccount(authorization);
    const actorScopes = new Set(actor.scopes as string[]);
    if (!actorScopes.has('*') && !actorScopes.has('identity.admin')) {
      throw new ForbiddenException('identity.admin scope is required');
    }
    const hasRoleUpdate =
      body.roles !== undefined || body.roleCodes !== undefined;
    const requestedRoles = body.roles?.length
      ? body.roles
      : (body.roleCodes ?? []).map((code) => ({ code }));
    let definitions: RoleDefinition[] = [];
    if (
      hasRoleUpdate &&
      !actorScopes.has('*') &&
      !actorScopes.has('identity.roles.assign')
    ) {
      throw new ForbiddenException('identity.roles.assign scope is required');
    }
    if (hasRoleUpdate && requestedRoles.length > 0) {
      const catalogue = await this.roleService.listAdminRoles(authorization);
      definitions = catalogue.items as RoleDefinition[];
    }

    const profile = this.normalizeProfile(body);
    const client = await this.connect();
    try {
      await client.query('BEGIN');
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
          WHERE a.id = $1 FOR UPDATE OF a`,
        [accountId],
      );
      const account = result.rows[0];
      if (!account) throw new NotFoundException('account not found');

      const nextStatus = body.status ?? account.status;
      const anonymize = Boolean(body.anonymize && nextStatus === 'DEACTIVATED');
      let email: string | null | undefined;
      let emailKey: string | null = null;
      if ('email' in body) {
        email = body.email || null;
        emailKey = email?.trim() ? unicodeCaseFold(email.trim()) : null;
        if (emailKey) {
          const duplicate = await client.query(
            `SELECT 1 FROM public.account
              WHERE identity_email_key = $1 AND id <> $2`,
            [emailKey, accountId],
          );
          if (duplicate.rowCount) {
            throw new BadRequestException('email already exists');
          }
        }
      }

      const nextDisplayName = anonymize
        ? 'Deactivated account'
        : body.displayName;
      const nextEmail = anonymize ? null : email;
      const updates: string[] = [];
      const values: unknown[] = [accountId];
      const set = (column: string, value: unknown) => {
        values.push(value);
        updates.push(`${column} = $${values.length}`);
      };
      if (nextDisplayName !== undefined) set('display_name', nextDisplayName);
      if ('email' in body || anonymize) {
        set('email', nextEmail ?? null);
        set('identity_email_key', anonymize ? null : (emailKey ?? null));
      }
      if (body.participationType !== undefined) {
        set('participation_type', body.participationType);
      }
      if (body.status !== undefined) set('status', body.status);
      updates.push('updated_at = now()');
      await client.query(
        `UPDATE public.account SET ${updates.join(', ')} WHERE id = $1`,
        values,
      );

      const updateWebsite = 'websiteUrl' in body || anonymize;
      const updateBiography = 'biographyMarkdown' in body || anonymize;
      if (updateWebsite || updateBiography || anonymize) {
        await client.query(
          `INSERT INTO public.identity_account_profile
             (account_id, website_url, biography_markdown,
              profile_image_id, profile_image_media_type, profile_image_updated_at)
           VALUES ($1, $2, $3, NULL, NULL, NULL)
           ON CONFLICT (account_id) DO UPDATE SET
             website_url = CASE WHEN $4 THEN EXCLUDED.website_url
                                ELSE identity_account_profile.website_url END,
             biography_markdown = CASE WHEN $5 THEN EXCLUDED.biography_markdown
                                       ELSE identity_account_profile.biography_markdown END,
             profile_image_id = CASE WHEN $6 THEN NULL
                                     ELSE identity_account_profile.profile_image_id END,
             profile_image_media_type = CASE WHEN $6 THEN NULL
                                             ELSE identity_account_profile.profile_image_media_type END,
             profile_image_updated_at = CASE WHEN $6 THEN NULL
                                             ELSE identity_account_profile.profile_image_updated_at END`,
          [
            accountId,
            anonymize ? null : (profile.websiteUrl ?? null),
            anonymize ? null : (profile.biographyMarkdown ?? null),
            updateWebsite,
            updateBiography,
            anonymize,
          ],
        );
      }

      if (body.password) {
        if (Array.from(body.password).length < 12) {
          throw new BadRequestException(
            'password must contain at least 12 characters',
          );
        }
        await client.query(
          `INSERT INTO public.account_credential
             (account_id, password_hash, password_changed_at, failed_attempts, locked_until)
           VALUES ($1, $2, now(), 0, NULL)
           ON CONFLICT (account_id) DO UPDATE SET
             password_hash = EXCLUDED.password_hash,
             password_changed_at = EXCLUDED.password_changed_at,
             failed_attempts = 0,
             locked_until = NULL`,
          [accountId, await hashPassword(body.password)],
        );
        await client.query(
          `UPDATE public.auth_session SET revoked_at = coalesce(revoked_at, now())
            WHERE account_id = $1`,
          [accountId],
        );
      }

      if (
        nextStatus === 'DEACTIVATED' &&
        (anonymize || account.status !== 'DEACTIVATED')
      ) {
        await client.query(
          `UPDATE public.auth_session SET revoked_at = coalesce(revoked_at, now())
            WHERE account_id = $1`,
          [accountId],
        );
        await writeSecurityEvent(client, 'identity.account.deactivated.v1', {
          accountId,
          anonymized: anonymize,
        });
      }
      await writeSecurityEvent(client, 'identity.account.admin-updated.v1', {
        accountId,
        fields: Object.keys(body).sort(),
      });

      let roles: Record<string, unknown>[];
      if (hasRoleUpdate) {
        if (actor.id === accountId) {
          throw new ForbiddenException(
            'actors cannot change their own role assignments',
          );
        }
        roles = await this.replaceRoles(
          client,
          accountId,
          requestedRoles,
          actorScopes,
          actor.id as string,
          definitions,
        );
      } else {
        roles = await this.readRolesForAccount(client, accountId);
      }

      const updated = await client.query<AccountRecord>(
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
      const callsigns = await client.query(
        `SELECT c.id, c.value, c.lifecycle_status AS status,
                c.source,
                c.verification_source AS "verificationSource",
                c.verified_at AS "verifiedAt", c.valid_from AS "validFrom",
                c.valid_to AS "validTo", c.created_at AS "createdAt",
                c.updated_at AS "updatedAt",
                coalesce(array_agg(e.id) FILTER (WHERE e.id IS NOT NULL), '{}')
                  AS "evidenceIds"
           FROM public.callsign c
           LEFT JOIN public.callsign_evidence e ON e.callsign_id = c.id
          WHERE c.account_id = $1
          GROUP BY c.id
          ORDER BY c.valid_from NULLS FIRST, c.value`,
        [accountId],
      );
      await client.query('COMMIT');
      if (anonymize && account.profile_image_id)
        this.profileImages.deleteObjectBestEffort(
          accountId,
          account.profile_image_id,
        );
      return {
        ...this.accountView(updated.rows[0]),
        callsigns: callsigns.rows,
        roles,
      };
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

  async exportAccount(
    authorization: string,
    accountId: string,
  ): Promise<Record<string, unknown>> {
    await this.authorizeAccountTarget(authorization, accountId);
    const client = await this.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const account = await this.readAccountView(client, accountId);
      const roles = await this.readRolesForAccount(client, accountId);
      const evidence = await client.query(
        `SELECT e.id, e.callsign_id AS "callsignId", c.account_id AS "accountId",
                e.evidence_type AS "evidenceType", e.source, e.checksum,
                e.metadata, e.status, e.submitted_at AS "submittedAt",
                e.reviewed_at AS "reviewedAt"
           FROM public.callsign_evidence e
           JOIN public.callsign c ON c.id = e.callsign_id
          WHERE c.account_id = $1
          ORDER BY e.submitted_at, e.id`,
        [accountId],
      );
      const securityEvents = await client.query(
        `SELECT id, event_type AS "eventType", occurred_at AS "occurredAt",
                payload
           FROM public.security_event
          WHERE payload ->> 'accountId' = $1
          ORDER BY occurred_at, id`,
        [accountId],
      );
      await client.query('COMMIT');
      return {
        account,
        roles,
        callsignEvidence: evidence.rows,
        securityEvents: securityEvents.rows,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
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
      return await this.readRolesForAccount(client, accountId);
    } finally {
      client.release();
    }
  }

  private normalizeProfile(body: UpdateAccountDto) {
    const profile: {
      websiteUrl?: string | null;
      biographyMarkdown?: string | null;
    } = {};
    if ('websiteUrl' in body) {
      profile.websiteUrl = validateWebsiteUrl(body.websiteUrl);
    }
    if ('biographyMarkdown' in body) {
      const value = body.biographyMarkdown;
      if (value !== null && typeof value !== 'string') {
        throw new BadRequestException(
          'biographyMarkdown must be a string or null',
        );
      }
      if (typeof value === 'string' && Array.from(value).length > 2000) {
        throw new BadRequestException(
          'biographyMarkdown exceeds 2000 characters',
        );
      }
      profile.biographyMarkdown = value === '' ? null : value;
    }
    return profile;
  }

  private async replaceRoles(
    client: PoolClient,
    accountId: string,
    requested: RoleGrantDto[],
    actorScopes: Set<string>,
    actorId: string,
    definitions: RoleDefinition[],
  ) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('identity-global-role-assignments', 0))",
    );
    const current = await client.query<{
      role: string;
      programmeSlug: string | null;
      jurisdiction: string | null;
      entityType: string | null;
    }>(
      `SELECT role_code AS role, programme_slug AS "programmeSlug",
              jurisdiction_code AS jurisdiction, entity_type_code AS "entityType"
         FROM public.account_role
        WHERE account_id = $1 AND valid_to IS NULL`,
      [accountId],
    );
    const remaining = new Map<string, number>();
    const assignmentKey = (
      role: string,
      programmeSlug: string | null,
      jurisdiction: string | null,
      entityType: string | null,
    ) => JSON.stringify([role, programmeSlug, jurisdiction, entityType]);
    for (const role of current.rows) {
      const key = assignmentKey(
        role.role,
        role.programmeSlug,
        role.jurisdiction,
        role.entityType,
      );
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }

    const actorPrivileges = new Set(actorScopes);
    actorPrivileges.delete('identity.me');
    const normalized: RoleGrant[] = requested.map((assignment) => {
      const code = (assignment.code || assignment.role || '').toUpperCase();
      const definition = definitions.find((item) => item.code === code);
      if (!definition) throw new BadRequestException(`unknown role: ${code}`);
      const grant: RoleGrant = {
        code,
        programmeSlug: assignment.programmeSlug ?? null,
        jurisdiction: assignment.jurisdiction ?? null,
        entityType: assignment.entityType ?? null,
        scopes: definition.scopes,
      };
      const targetScopes = definition.scopes;
      const mayGrant =
        !targetScopes.includes('*') &&
        (actorPrivileges.has('*') ||
          (targetScopes.every((scope) => actorPrivileges.has(scope)) &&
            targetScopes.length < actorPrivileges.size));
      if (!mayGrant) {
        const key = assignmentKey(
          code,
          grant.programmeSlug,
          grant.jurisdiction,
          grant.entityType,
        );
        const count = remaining.get(key) ?? 0;
        if (count < 1) {
          throw new ForbiddenException(
            'actors may grant only roles strictly below their authority',
          );
        }
        remaining.set(key, count - 1);
      }
      return grant;
    });

    const currentGlobal = current.rows.some(
      (assignment) => assignment.role === 'GLOBAL_OPERATOR',
    );
    const nextGlobal = normalized.some(
      (assignment) => assignment.code === 'GLOBAL_OPERATOR',
    );
    if (currentGlobal && !nextGlobal) {
      const count = await client.query<{ count: string }>(
        `SELECT count(DISTINCT account_id)::text AS count
           FROM public.account_role
          WHERE role_code = 'GLOBAL_OPERATOR' AND valid_to IS NULL`,
      );
      if (Number(count.rows[0]?.count ?? 0) <= 1) {
        throw new BadRequestException(
          'the last global administrator cannot lose the global administrator role',
        );
      }
    }

    await client.query(
      `UPDATE public.account_role SET valid_to = now()
        WHERE account_id = $1 AND valid_to IS NULL`,
      [accountId],
    );
    const roles = await this.assignRoles(client, accountId, normalized);
    await writeSecurityEvent(client, 'identity.roles.replaced.v1', {
      accountId,
      roles,
      actorId,
    });
    return roles;
  }

  private async readRolesForAccount(client: PoolClient, accountId: string) {
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
        WHERE ar.account_id = $1 AND ar.valid_to IS NULL
        ORDER BY ar.created_at, ar.id`,
      [accountId],
    );
    return result.rows.map((role) => ({
      ...role,
      scopes:
        role.role === 'GLOBAL_OPERATOR' && role.scopes.length > 1
          ? role.scopes
          : (DEFAULT_ROLE_SCOPES[role.role] ?? role.scopes),
    }));
  }

  private accountView(account: AccountRecord) {
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
      primaryCallsignId: account.primary_callsign_id,
      createdAt: account.created_at,
      updatedAt: account.updated_at,
    };
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

  private async readIdempotentResult(
    client: PoolClient,
    key?: string,
  ): Promise<Record<string, unknown> | null> {
    if (!key) return null;
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('identity:' || $1, 0))",
      [key],
    );
    const result = await client.query<{
      response: Record<string, unknown>;
    }>(
      `SELECT response FROM public.idempotency_record
        WHERE service = 'identity' AND key = $1`,
      [key],
    );
    return result.rows[0]?.response ?? null;
  }

  private async storeIdempotentResult(
    client: PoolClient,
    key: string | undefined,
    response: Record<string, unknown>,
  ) {
    if (!key) return;
    await client.query(
      `INSERT INTO public.idempotency_record (service, key, response)
       VALUES ('identity', $1, $2::jsonb)`,
      [key, JSON.stringify(response)],
    );
  }

  private async readAccountView(client: PoolClient, accountId: string) {
    const accountResult = await client.query<AccountRecord>(
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
    const account = accountResult.rows[0];
    if (!account) throw new NotFoundException('account not found');
    const callsigns = await client.query(
      `SELECT c.id, c.value, c.lifecycle_status AS status, c.source,
              c.verification_source AS "verificationSource",
              c.verified_at AS "verifiedAt", c.valid_from AS "validFrom",
              c.valid_to AS "validTo", c.created_at AS "createdAt",
              c.updated_at AS "updatedAt",
              coalesce(array_agg(e.id) FILTER (WHERE e.id IS NOT NULL), '{}')
                AS "evidenceIds"
         FROM public.callsign c
         LEFT JOIN public.callsign_evidence e ON e.callsign_id = c.id
        WHERE c.account_id = $1
        GROUP BY c.id
        ORDER BY c.valid_from NULLS FIRST, c.value`,
      [accountId],
    );
    return { ...this.accountView(account), callsigns: callsigns.rows };
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
