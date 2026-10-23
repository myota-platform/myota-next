import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  ValidationPipe,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { utcTimestamp } from '@app/platform/utc-timestamp.js';
import { parseJsonWithExactIntegers } from '@app/platform/json-exact.js';
import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import {
  nextPageIfMore,
  pageOffset,
  parsePageInteger,
  parsePageTotal,
} from '@app/platform/pagination.js';
import { writeOutboxEvent, writeSecurityEvent } from '@app/platform/outbox.js';
import {
  pythonKeyErrorDetail,
  trimPythonWhitespace,
} from '@app/platform/python-strings.js';
import { pythonTruthy } from '@app/platform/python-truthiness.js';
import { unicodeCaseFold } from '@app/platform/unicode-casefold.js';
import {
  IdentityAuthService,
  hashPassword,
  validateWebsiteUrl,
} from './auth.service.js';
import { IdentityRoleService } from './identity-role.service.js';
import { IdentityProfileImageService } from './identity-profile-image.service.js';
import type { CreateAccountDto, RoleGrantDto } from './auth.dto.js';
import { ReplaceAccountRolesDto, UpdateAccountDto } from './auth.dto.js';
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
  profile_image_updated_at: string | null;
  primary_callsign_id: string | null;
  created_at: string;
  updated_at: string;
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
    body: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    const actor = await this.auth.currentAccount(authorization);
    const actorScopes = new Set(actor.scopes as string[]);
    if (!actorScopes.has('*') && !actorScopes.has('identity.accounts.create')) {
      throw new ForbiddenException(
        'identity.accounts.create scope is required',
      );
    }
    const missing = ['displayName', 'participationType', 'email'].filter(
      (field) => !pythonTruthy(body[field]),
    );
    if (missing.length)
      throw new BadRequestException(
        `missing required fields: ${missing.join(', ')}`,
      );
    if ('password' in body) {
      throw new BadRequestException(
        'passwords cannot be set during account creation; use the invitation setup flow',
      );
    }
    if (body.roles != null && !Array.isArray(body.roles))
      throw new BadRequestException('roles must be an array');
    if (
      body.participationType !== 'OPERATOR' &&
      body.participationType !== 'SWL'
    )
      throw new BadRequestException(
        'participationType must be OPERATOR or SWL',
      );
    const email = String(body.email);
    const normalizedEmail = unicodeCaseFold(trimPythonWhitespace(email));
    if (!normalizedEmail.includes('@')) {
      throw new BadRequestException('email must be a valid address');
    }

    const additionalAssignments = (body.roles ?? []) as RoleGrantDto[];
    if (
      additionalAssignments.some(
        (role) => !role || typeof role !== 'object' || Array.isArray(role),
      )
    )
      throw new BadRequestException('each role assignment must be an object');
    const input = {
      displayName: String(body.displayName),
      email: normalizedEmail,
      participationType: body.participationType as 'OPERATOR' | 'SWL',
      callsign: pythonTruthy(body.callsign)
        ? (body.callsign as string)
        : undefined,
      roles: additionalAssignments,
    } as CreateAccountDto;
    let grants: RoleGrant[] = [];

    const client = await this.connect();
    try {
      await client.query('BEGIN');
      if (idempotencyKey) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('identity:' || $1, 0))",
          [idempotencyKey],
        );
        const previous = await client.query<{
          response_text: string;
        }>(
          `SELECT response::text AS response_text FROM public.idempotency_record
            WHERE service = 'identity' AND key = $1`,
          [idempotencyKey],
        );
        if (previous.rows[0]) {
          await client.query('COMMIT');
          return parseJsonWithExactIntegers(
            previous.rows[0].response_text,
          ) as Record<string, unknown>;
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

      if (additionalAssignments.length > 0) {
        if (
          !actorScopes.has('*') &&
          !actorScopes.has('identity.roles.assign')
        ) {
          throw new ForbiddenException(
            'identity.roles.assign scope is required',
          );
        }
        const definitions =
          await this.roleService.readRoleDefinitionsForTransaction(client);
        grants = this.validateRoleGrants(
          additionalAssignments,
          actorScopes,
          definitions,
        );
      }

      const accountId = randomUUID();
      const accountResult = await client.query<{
        created_at: string;
        updated_at: string;
      }>(
        `INSERT INTO public.account
           (id, display_name, email, identity_email_key, participation_type,
            status, created_at, updated_at)
         VALUES ($1, $2, $3::text::public.citext, $3::text, $4, 'PENDING_SETUP',
                 clock_timestamp(), clock_timestamp())
         RETURNING to_char(created_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
                   to_char(updated_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at`,
        [
          accountId,
          input.displayName,
          normalizedEmail,
          input.participationType,
        ],
      );

      const callsigns: Record<string, unknown>[] = [];
      let primaryCallsignId: string | null = null;
      let accountUpdatedAt = accountResult.rows[0].updated_at;
      let callsignValue: string | undefined;
      if (input.callsign) {
        callsignValue = trimPythonWhitespace(input.callsign).toUpperCase();
        if (!callsignValue) {
          throw new BadRequestException('callsign cannot be empty');
        }
      }
      if (callsignValue) {
        const callsignId = randomUUID();
        const callsignResult = await client.query<{
          created_at: string;
          updated_at: string;
        }>(
          `INSERT INTO public.callsign
             (id, account_id, value, lifecycle_status, source,
              verification_source, created_at, updated_at)
           VALUES ($1, $2, $3, 'UNVERIFIED', 'self-asserted', NULL,
                   clock_timestamp(), clock_timestamp())
           RETURNING to_char(created_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
                     to_char(updated_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at`,
          [callsignId, accountId, callsignValue],
        );
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
          createdAt: callsignResult.rows[0].created_at,
          updatedAt: callsignResult.rows[0].updated_at,
        };
        callsigns.push(callsign);
        if (input.participationType === 'OPERATOR') {
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
        const accountUpdate = await client.query<{ updated_at: string }>(
          `UPDATE public.account SET updated_at = clock_timestamp()
            WHERE id = $1 RETURNING to_char(updated_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at`,
          [accountId],
        );
        accountUpdatedAt = accountUpdate.rows[0].updated_at;
      }

      const account = {
        id: accountId,
        displayName: input.displayName,
        email: normalizedEmail,
        participationType: input.participationType,
        status: 'PENDING_SETUP',
        websiteUrl: null,
        biographyMarkdown: null,
        profileImage: null,
        callsigns,
        primaryCallsignId,
        createdAt: accountResult.rows[0].created_at,
        updatedAt: accountUpdatedAt,
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
          [idempotencyKey, stringifyJsonWithBigInts(response)],
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
    const pageSize = parsePageInteger(query.pageSize, 50, 100);
    const client = await this.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const countResult = await client.query<{ total: string }>(
        'SELECT count(*)::text AS total FROM public.security_event',
      );
      const eventsResult = await client.query<{
        id: string;
        event_type: string;
        payload_text: string;
        occurred_at: string;
      }>(
        `SELECT id, event_type, payload::text AS payload_text,
                to_char(occurred_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at
             FROM public.security_event
            ORDER BY occurred_at DESC, event_order ASC
            LIMIT $1 OFFSET $2`,
        [pageSize, pageOffset(page, pageSize)],
      );
      await client.query('COMMIT');
      const total = parsePageTotal(countResult.rows[0]?.total ?? '0');
      return {
        items: eventsResult.rows.map((event) => ({
          id: event.id,
          eventType: event.event_type,
          occurredAt: event.occurred_at,
          payload: parseJsonWithExactIntegers(event.payload_text),
        })),
        page,
        pageSize,
        total,
        nextPage: nextPageIfMore(page, pageSize, total),
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
    this.validateAccountPathId(accountId);
    const client = await this.connect();
    try {
      const result = await client.query<AccountRecord>(
        `SELECT a.id, a.display_name, a.email::text AS email,
                a.participation_type, a.status,
                to_char(a.created_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
                to_char(a.updated_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
                p.website_url, p.biography_markdown, p.profile_image_id,
                p.profile_image_media_type,
                to_char(p.profile_image_updated_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS profile_image_updated_at,
                primary_call.callsign_id AS primary_callsign_id
           FROM public.account a
           LEFT JOIN public.identity_account_profile p ON p.account_id = a.id
           LEFT JOIN public.account_primary_callsign primary_call
             ON primary_call.account_id = a.id
          WHERE a.id = $1`,
        [accountId],
      );
      const account = result.rows[0];
      if (!account)
        throw new NotFoundException(pythonKeyErrorDetail(accountId));
      const callsigns = await client.query(
        `SELECT c.id, c.value, c.lifecycle_status AS status,
                c.source,
                c.verification_source AS "verificationSource",
                to_char(c.verified_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "verifiedAt",
                to_char(c.valid_from AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "validFrom",
                to_char(c.valid_to AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "validTo",
                to_char(c.created_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
                to_char(c.updated_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt",
                coalesce(array_agg(e.id ORDER BY e.evidence_order)
                  FILTER (WHERE e.id IS NOT NULL), '{}')
                  AS "evidenceIds"
           FROM public.callsign c
           LEFT JOIN public.callsign_evidence e ON e.callsign_id = c.id
          WHERE c.account_id = $1
          GROUP BY c.id
          ORDER BY c.created_order`,
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

  async updateAccount(
    authorization: string,
    accountId: string,
    rawBody: unknown,
    rolesOnly = false,
  ): Promise<Record<string, unknown>> {
    const actor = await this.auth.currentAccount(authorization);
    const actorScopes = new Set(actor.scopes as string[]);
    if (!actorScopes.has('*') && !actorScopes.has('identity.admin')) {
      throw new ForbiddenException('identity.admin scope is required');
    }
    this.validateAccountPathId(accountId);
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<AccountRecord>(
        `SELECT a.id, a.display_name, a.email::text AS email,
                a.participation_type, a.status,
                to_char(a.created_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
                to_char(a.updated_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
                p.website_url, p.biography_markdown, p.profile_image_id,
                p.profile_image_media_type,
                to_char(p.profile_image_updated_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS profile_image_updated_at,
                primary_call.callsign_id AS primary_callsign_id
           FROM public.account a
           LEFT JOIN public.identity_account_profile p ON p.account_id = a.id
           LEFT JOIN public.account_primary_callsign primary_call
             ON primary_call.account_id = a.id
          WHERE a.id = $1 FOR UPDATE OF a`,
        [accountId],
      );
      const account = result.rows[0];
      if (!account)
        throw new NotFoundException(pythonKeyErrorDetail(accountId));

      let profile: ReturnType<IdentityAccountService['normalizeProfile']> = {};
      let emailKey: string | null = null;
      if (!rolesOnly) {
        const raw =
          rawBody !== null &&
          typeof rawBody === 'object' &&
          !Array.isArray(rawBody)
            ? (rawBody as Record<string, unknown>)
            : {};
        profile = this.normalizeProfile({
          websiteUrl: raw.websiteUrl as UpdateAccountDto['websiteUrl'],
          biographyMarkdown:
            raw.biographyMarkdown as UpdateAccountDto['biographyMarkdown'],
        });
        if (Object.hasOwn(raw, 'email')) {
          const candidate = pythonTruthy(raw.email) ? raw.email : null;
          const normalizedEmail =
            typeof candidate === 'string'
              ? trimPythonWhitespace(candidate)
              : '';
          emailKey = normalizedEmail ? unicodeCaseFold(normalizedEmail) : null;
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
      }

      const body = rolesOnly
        ? {
            roles: (await validateRoleAssignmentBody(rawBody)).roles,
          }
        : await validateUpdateAccountBody(rawBody);
      const hasRoleUpdate =
        body.roles !== undefined || body.roleCodes !== undefined;
      const requestedRoles = body.roles?.length
        ? body.roles
        : (body.roleCodes ?? []).map((code) => ({ code }));
      const nextStatus = body.status ?? account.status;
      const anonymize = Boolean(body.anonymize && nextStatus === 'DEACTIVATED');
      const email = body.email === undefined ? undefined : body.email || null;

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
      if (body.email !== undefined || anonymize) {
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

      const updateWebsite = body.websiteUrl !== undefined || anonymize;
      const updateBiography = body.biographyMarkdown !== undefined || anonymize;
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
          `UPDATE public.auth_session SET revoked_at = clock_timestamp()
            WHERE account_id = $1`,
          [accountId],
        );
      }

      if (anonymize) {
        await client.query(
          `UPDATE public.auth_session SET revoked_at = clock_timestamp()
            WHERE account_id = $1`,
          [accountId],
        );
        await writeSecurityEvent(client, 'identity.account.deactivated.v1', {
          accountId,
          anonymized: true,
        });
      }
      await writeSecurityEvent(client, 'identity.account.admin-updated.v1', {
        accountId,
        fields: Object.keys(body).sort(),
      });

      let roles: Record<string, unknown>[];
      if (hasRoleUpdate) {
        if (
          !actorScopes.has('*') &&
          !actorScopes.has('identity.roles.assign')
        ) {
          throw new ForbiddenException(
            'identity.roles.assign scope is required',
          );
        }
        if (actor.id === accountId) {
          throw new ForbiddenException(
            'actors cannot change their own role assignments',
          );
        }
        const definitions =
          requestedRoles.length > 0
            ? await this.roleService.readRoleDefinitionsForTransaction(client)
            : [];
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
                a.participation_type, a.status,
                to_char(a.created_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
                to_char(a.updated_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
                p.website_url, p.biography_markdown, p.profile_image_id,
                p.profile_image_media_type,
                to_char(p.profile_image_updated_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS profile_image_updated_at,
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
                to_char(c.verified_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "verifiedAt",
                to_char(c.valid_from AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "validFrom",
                to_char(c.valid_to AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "validTo",
                to_char(c.created_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
                to_char(c.updated_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt",
                coalesce(
                  array_agg(e.id ORDER BY e.evidence_order)
                    FILTER (WHERE e.id IS NOT NULL),
                  '{}'
                )
                  AS "evidenceIds"
           FROM public.callsign c
           LEFT JOIN public.callsign_evidence e ON e.callsign_id = c.id
          WHERE c.account_id = $1
          GROUP BY c.id
          ORDER BY c.created_order`,
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
    this.validateAccountPathId(accountId);
    const client = await this.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const account = await this.readAccountView(client, accountId);
      const roles = await this.readRolesForAccount(client, accountId);
      const evidence = await client.query(
        `SELECT e.id, e.callsign_id AS "callsignId", c.account_id AS "accountId",
                e.evidence_type AS "evidenceType", e.source, e.checksum,
                e.metadata::text AS "metadataText", e.status,
                to_char(e.submitted_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "submittedAt",
                to_char(e.reviewed_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "reviewedAt"
           FROM public.callsign_evidence e
           JOIN public.callsign c ON c.id = e.callsign_id
          WHERE c.account_id = $1
          ORDER BY e.evidence_order`,
        [accountId],
      );
      const securityEvents = await client.query(
        `SELECT id, event_type AS "eventType",
                to_char(occurred_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt",
                payload::text AS "payloadText"
           FROM public.security_event
          WHERE payload ->> 'accountId' = $1
          ORDER BY event_order`,
        [accountId],
      );
      await client.query('COMMIT');
      return {
        account,
        roles,
        callsignEvidence: evidence.rows.map((row) => ({
          ...row,
          metadata: parseJsonWithExactIntegers(row.metadataText),
          metadataText: undefined,
        })),
        securityEvents: securityEvents.rows.map((row) => ({
          ...row,
          payload: parseJsonWithExactIntegers(row.payloadText),
          payloadText: undefined,
        })),
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
    if (body.websiteUrl !== undefined) {
      profile.websiteUrl = validateWebsiteUrl(body.websiteUrl);
    }
    if (body.biographyMarkdown !== undefined) {
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

    const changedAt = await utcTimestamp(client);
    await client.query(
      `UPDATE public.account_role SET valid_to = $2
        WHERE account_id = $1 AND valid_to IS NULL`,
      [accountId, changedAt],
    );
    const roles = await this.assignRoles(
      client,
      accountId,
      normalized,
      changedAt,
    );
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
      createdAt: string;
      validTo: string | null;
    }>(
      `SELECT ar.account_id AS "accountId", ar.id, ar.role_code AS role,
              ar.programme_id AS "programmeId",
              coalesce(ar.programme_slug, p.slug) AS "programmeSlug",
              ar.jurisdiction_id AS "jurisdictionId",
              coalesce(ar.jurisdiction_code, j.code) AS jurisdiction,
              ar.entity_type_code AS "entityType",
              coalesce(rd.scopes, ARRAY(SELECT jsonb_array_elements_text(ar.scopes))) AS scopes,
              to_char(ar.created_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
              to_char(ar.valid_to AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "validTo"
         FROM public.account_role ar
         LEFT JOIN public.identity_role_definition rd ON rd.role_code = ar.role_code
         LEFT JOIN public.programme p ON p.id = ar.programme_id
         LEFT JOIN public.jurisdiction j ON j.id = ar.jurisdiction_id
        WHERE ar.account_id = $1 AND ar.valid_to IS NULL
        ORDER BY ar.assignment_order`,
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

  private validateAccountPathId(accountId: string) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(accountId))
      throw new NotFoundException(pythonKeyErrorDetail(accountId));
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
    createdAt?: string,
  ) {
    const result: Record<string, unknown>[] = [];
    const assignmentTime = createdAt ?? (await utcTimestamp(client));
    for (const assignment of assignments) {
      const id = randomUUID();
      await client.query(
        `INSERT INTO public.account_role
           (id, account_id, programme_id, role_code, jurisdiction_id,
            entity_type_code, scopes, programme_slug, jurisdiction_code, created_at)
         VALUES ($1, $2,
                 (SELECT id FROM public.programme WHERE slug = $3::text), $4,
                 NULL, $5, $6::jsonb, $3::text, $7, $8)`,
        [
          id,
          accountId,
          assignment.programmeSlug,
          assignment.code,
          assignment.entityType,
          JSON.stringify(assignment.scopes),
          assignment.jurisdiction,
          assignmentTime,
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
        createdAt: assignmentTime,
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
      response_text: string;
    }>(
      `SELECT response::text AS response_text FROM public.idempotency_record
        WHERE service = 'identity' AND key = $1`,
      [key],
    );
    return result.rows[0]
      ? (parseJsonWithExactIntegers(result.rows[0].response_text) as Record<
          string,
          unknown
        >)
      : null;
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
      [key, stringifyJsonWithBigInts(response)],
    );
  }

  private async readAccountView(client: PoolClient, accountId: string) {
    const accountResult = await client.query<AccountRecord>(
      `SELECT a.id, a.display_name, a.email::text AS email,
              a.participation_type, a.status,
              to_char(a.created_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
              to_char(a.updated_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
              p.website_url, p.biography_markdown, p.profile_image_id,
              p.profile_image_media_type,
              to_char(p.profile_image_updated_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS profile_image_updated_at,
              primary_call.callsign_id AS primary_callsign_id
         FROM public.account a
         LEFT JOIN public.identity_account_profile p ON p.account_id = a.id
         LEFT JOIN public.account_primary_callsign primary_call
           ON primary_call.account_id = a.id
        WHERE a.id = $1`,
      [accountId],
    );
    const account = accountResult.rows[0];
    if (!account) throw new NotFoundException(pythonKeyErrorDetail(accountId));
    const callsigns = await client.query(
      `SELECT c.id, c.value, c.lifecycle_status AS status, c.source,
              c.verification_source AS "verificationSource",
              to_char(c.verified_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "verifiedAt",
              to_char(c.valid_from AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "validFrom",
              to_char(c.valid_to AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "validTo",
              to_char(c.created_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
              to_char(c.updated_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt",
              coalesce(
                array_agg(e.id ORDER BY e.evidence_order)
                  FILTER (WHERE e.id IS NOT NULL),
                '{}'
              )
                AS "evidenceIds"
         FROM public.callsign c
         LEFT JOIN public.callsign_evidence e ON e.callsign_id = c.id
        WHERE c.account_id = $1
        GROUP BY c.id
        ORDER BY c.created_order`,
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

const updateAccountValidationPipe = new ValidationPipe({
  transform: true,
  whitelist: true,
});
const roleAssignmentValidationPipe = new ValidationPipe({
  transform: true,
  whitelist: true,
});

async function validateUpdateAccountBody(
  body: unknown,
): Promise<UpdateAccountDto> {
  return (await updateAccountValidationPipe.transform(body, {
    type: 'body',
    metatype: UpdateAccountDto,
  })) as UpdateAccountDto;
}

async function validateRoleAssignmentBody(
  body: unknown,
): Promise<ReplaceAccountRolesDto> {
  return (await roleAssignmentValidationPipe.transform(body, {
    type: 'body',
    metatype: ReplaceAccountRolesDto,
  })) as ReplaceAccountRolesDto;
}
