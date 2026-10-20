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
import { writeOutboxEvent } from '@app/platform/outbox.js';
import { trimPythonWhitespace } from '@app/platform/python-strings.js';
import { IdentityAuthService } from './auth.service.js';
import type {
  AddCallsignDto,
  CallsignEvidenceDto,
  RetireCallsignDto,
  SetPrimaryCallsignDto,
  VerifyCallsignDto,
} from './auth.dto.js';

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
export class IdentityCallsignService {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
    private readonly auth: IdentityAuthService,
  ) {}

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
      const value = trimPythonWhitespace(body.callsign).toUpperCase();
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
      const metadata = body.metadata === undefined ? {} : body.metadata;
      const evidence = {
        id: evidenceId,
        callsignId,
        accountId,
        evidenceType: body.evidenceType,
        source: body.source,
        checksum: body.checksum ?? null,
        metadata,
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
          JSON.stringify(metadata),
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
        `SELECT id FROM public.callsign_evidence
          WHERE callsign_id = $1 ORDER BY submitted_at, id`,
        [callsignId],
      );
      if (!evidence.rowCount) {
        throw new BadRequestException(
          'at least one evidence record is required',
        );
      }
      const verifiedAt = new Date();
      const verificationSource =
        body.source === undefined ? 'manual-review' : body.source;
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
      const evidence = await client.query<{ id: string }>(
        `SELECT id FROM public.callsign_evidence
          WHERE callsign_id = $1 ORDER BY submitted_at, id`,
        [callsignId],
      );
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
      const validTo =
        body.validTo === undefined
          ? new Date()
          : body.validTo === null
            ? null
            : new Date(body.validTo);
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
        evidenceIds: evidence.rows.map((item) => item.id),
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
    const result = await client.query<{ response: Record<string, unknown> }>(
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
