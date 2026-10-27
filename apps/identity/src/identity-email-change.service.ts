import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { writeOutboxEvent, writeSecurityEvent } from '@app/platform/outbox.js';
import { trimPythonWhitespace } from '@app/platform/python-strings.js';
import { unicodeCaseFold } from '@app/platform/unicode-casefold.js';
import { IdentityAuthService, verifyPassword } from './auth.service.js';

const CHANGE_TTL_SECONDS = 86_400;
const TOKEN_TTL_SECONDS = 1_800;

@Injectable()
export class IdentityEmailChangeService {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
    private readonly auth: IdentityAuthService,
  ) {}

  async status(authorization: string) {
    const actor = await this.auth.currentAccount(authorization);
    const client = await this.connect();
    try {
      const result = await client.query<{
        id: string;
        old_email: string;
        new_email: string;
        old_verified_at: Date | null;
        new_verified_at: Date | null;
        expires_at: Date;
      }>(
        `SELECT id, old_email::text AS old_email, new_email::text AS new_email,
                old_verified_at, new_verified_at, expires_at
           FROM public.identity_email_change
          WHERE account_id = $1 AND canceled_at IS NULL
            AND completed_at IS NULL AND expires_at > clock_timestamp()
          ORDER BY created_at DESC LIMIT 1`,
        [actor.id],
      );
      const pending = result.rows[0];
      return {
        pending: pending
          ? {
              id: pending.id,
              currentEmail: pending.old_email,
              newEmail: pending.new_email,
              oldAddressVerified: Boolean(pending.old_verified_at),
              newAddressVerified: Boolean(pending.new_verified_at),
              expiresAt: pending.expires_at.toISOString(),
            }
          : null,
      };
    } finally {
      client.release();
    }
  }

  async request(authorization: string, rawBody: unknown) {
    const actor = await this.auth.currentAccount(authorization);
    const body = asRecord(rawBody);
    const newEmailInput =
      typeof body.newEmail === 'string'
        ? trimPythonWhitespace(body.newEmail)
        : '';
    const currentPassword =
      typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const newEmail = unicodeCaseFold(newEmailInput);
    if (
      Object.keys(body).some(
        (key) => !['newEmail', 'currentPassword'].includes(key),
      ) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail) ||
      newEmail.length > 254 ||
      Array.from(currentPassword).length < 1 ||
      Array.from(currentPassword).length > 128
    )
      throw new BadRequestException('email change details are invalid');

    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const rateLimitKey = createHash('sha256')
        .update(`email-change:${String(actor.id)}`)
        .digest('hex');
      const rateLimit = await client.query<{ request_count: number }>(
        `INSERT INTO public.identity_registration_rate_limit
           (key_hash, window_started_at, request_count, expires_at)
         VALUES ($1, clock_timestamp(), 1,
                 clock_timestamp() + interval '15 minutes')
         ON CONFLICT (key_hash) DO UPDATE SET
           window_started_at = CASE
             WHEN identity_registration_rate_limit.expires_at <= clock_timestamp()
               THEN clock_timestamp()
             ELSE identity_registration_rate_limit.window_started_at END,
           request_count = CASE
             WHEN identity_registration_rate_limit.expires_at <= clock_timestamp()
               THEN 1
             ELSE identity_registration_rate_limit.request_count + 1 END,
           expires_at = CASE
             WHEN identity_registration_rate_limit.expires_at <= clock_timestamp()
               THEN clock_timestamp() + interval '15 minutes'
             ELSE identity_registration_rate_limit.expires_at END,
           updated_at = clock_timestamp()
         RETURNING request_count`,
        [rateLimitKey],
      );
      if ((rateLimit.rows[0]?.request_count ?? 0) > 5)
        throw new BadRequestException(
          'too many email change requests; try again later',
        );
      const accountResult = await client.query<{
        id: string;
        display_name: string;
        email: string;
        identity_email_key: string;
        password_hash: string | null;
      }>(
        `SELECT a.id, a.display_name, a.email::text AS email,
                a.identity_email_key, c.password_hash
           FROM public.account a
           JOIN public.account_credential c ON c.account_id = a.id
          WHERE a.id = $1 AND a.status = 'ACTIVE' AND a.email_verified = true
            AND EXISTS (
              SELECT 1 FROM public.account_role role
               WHERE role.account_id = a.id AND role.role_code = 'PARTICIPANT'
                 AND role.valid_to IS NULL
            )
          FOR UPDATE OF a, c`,
        [actor.id],
      );
      const account = accountResult.rows[0];
      if (
        !account ||
        !account.password_hash ||
        !(await verifyPassword(currentPassword, account.password_hash))
      )
        throw new BadRequestException('current password is incorrect');
      if (newEmail === account.identity_email_key)
        throw new BadRequestException('new email address must be different');

      const target = await client.query(
        `SELECT 1 FROM public.account WHERE identity_email_key = $1 AND id <> $2
         UNION ALL
         SELECT 1 FROM public.identity_email_change
          WHERE new_email_key = $1 AND account_id <> $2
            AND canceled_at IS NULL AND completed_at IS NULL
            AND expires_at > clock_timestamp()
         LIMIT 1`,
        [newEmail, actor.id],
      );
      if (target.rowCount)
        throw new BadRequestException('new email address is unavailable');

      await client.query(
        `UPDATE public.identity_email_change
            SET canceled_at = clock_timestamp()
          WHERE account_id = $1 AND canceled_at IS NULL AND completed_at IS NULL`,
        [actor.id],
      );
      await client.query(
        `UPDATE public.identity_email_change
            SET canceled_at = clock_timestamp()
          WHERE canceled_at IS NULL AND completed_at IS NULL
            AND expires_at <= clock_timestamp()`,
      );
      const changeId = randomUUID();
      await client.query(
        `INSERT INTO public.identity_email_change
           (id, account_id, old_email, old_email_key, new_email, new_email_key,
            expires_at)
         VALUES ($1, $2, $3, $4, $5, $6,
                 clock_timestamp() + ($7 * interval '1 second'))`,
        [
          changeId,
          actor.id,
          account.email,
          account.identity_email_key,
          newEmailInput,
          newEmail,
          CHANGE_TTL_SECONDS,
        ],
      );
      await this.queueEmail(
        client,
        changeId,
        String(actor.id),
        'participant-email-change-old.v1',
        account.display_name,
      );
      await this.queueEmail(
        client,
        changeId,
        String(actor.id),
        'participant-email-change-new.v1',
        account.display_name,
      );
      await writeSecurityEvent(client, 'identity.email-change.requested.v1', {
        accountId: actor.id,
      });
      await client.query('COMMIT');
      return { status: 'verification_required', expiresIn: CHANGE_TTL_SECONDS };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (isUniqueViolation(error))
        throw new BadRequestException('new email address is unavailable');
      throw error;
    } finally {
      client.release();
    }
  }

  async cancel(authorization: string) {
    const actor = await this.auth.currentAccount(authorization);
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE public.identity_email_change
            SET canceled_at = clock_timestamp()
          WHERE account_id = $1 AND canceled_at IS NULL
            AND completed_at IS NULL AND expires_at > clock_timestamp()`,
        [actor.id],
      );
      await writeSecurityEvent(client, 'identity.email-change.cancelled.v1', {
        accountId: actor.id,
      });
      await client.query('COMMIT');
      return { status: result.rowCount ? 'cancelled' : 'no_pending_change' };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async confirm(rawBody: unknown) {
    const body = asRecord(rawBody);
    const token = typeof body.token === 'string' ? body.token : '';
    if (
      Object.keys(body).some((key) => key !== 'token') ||
      !/^[A-Za-z0-9_-]{40,60}$/.test(token)
    )
      throw new BadRequestException(
        'email verification token is invalid or expired',
      );
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const tokenReference = await client.query<{ change_id: string }>(
        `SELECT change_id
           FROM public.identity_email_change_token
          WHERE token_hash = $1`,
        [tokenHash],
      );
      const changeId = tokenReference.rows[0]?.change_id;
      if (!changeId)
        throw new BadRequestException(
          'email verification token is invalid or expired',
        );

      // Both address tokens belong to the same change row. Lock that shared
      // row before the individual token rows so simultaneous old/new
      // confirmations serialize and the second transaction sees the first
      // address verification before deciding whether it can complete.
      const lockedChange = await client.query<{ id: string }>(
        `SELECT id
           FROM public.identity_email_change
          WHERE id = $1 AND expires_at > clock_timestamp()
            AND canceled_at IS NULL AND completed_at IS NULL
          FOR UPDATE`,
        [changeId],
      );
      if (!lockedChange.rows[0])
        throw new BadRequestException(
          'email verification token is invalid or expired',
        );
      const result = await client.query<{
        token_id: string;
        change_id: string;
        address_kind: 'old' | 'new';
        account_id: string;
        old_verified_at: Date | null;
        new_verified_at: Date | null;
        display_name: string;
        old_email_key: string;
        new_email: string;
        new_email_key: string;
      }>(
        `SELECT t.token_hash AS token_id, c.id AS change_id, t.address_kind,
                c.account_id, c.old_verified_at, c.new_verified_at,
                a.display_name, c.old_email_key, c.new_email::text AS new_email,
                c.new_email_key
           FROM public.identity_email_change_token t
           JOIN public.identity_email_change c ON c.id = t.change_id
           JOIN public.account a ON a.id = c.account_id
          WHERE t.token_hash = $1 AND t.change_id = $2 AND t.used_at IS NULL
            AND t.expires_at > clock_timestamp()
            AND c.expires_at > clock_timestamp() AND c.canceled_at IS NULL
            AND c.completed_at IS NULL
          FOR UPDATE OF t`,
        [tokenHash, changeId],
      );
      const verification = result.rows[0];
      if (!verification)
        throw new BadRequestException(
          'email verification token is invalid or expired',
        );
      await client.query(
        `UPDATE public.identity_email_change_token
            SET used_at = clock_timestamp() WHERE token_hash = $1`,
        [tokenHash],
      );
      const verifiedColumn =
        verification.address_kind === 'old'
          ? 'old_verified_at'
          : 'new_verified_at';
      await client.query(
        `UPDATE public.identity_email_change
            SET ${verifiedColumn} = coalesce(${verifiedColumn}, clock_timestamp())
          WHERE id = $1`,
        [verification.change_id],
      );
      const oldVerified =
        Boolean(verification.old_verified_at) ||
        verification.address_kind === 'old';
      const newVerified =
        Boolean(verification.new_verified_at) ||
        verification.address_kind === 'new';
      let status = 'one_address_verified';
      if (oldVerified && newVerified) {
        const updated = await client.query(
          `UPDATE public.account
              SET email = $1, identity_email_key = $2, email_verified = true,
                  updated_at = clock_timestamp()
            WHERE id = $3 AND identity_email_key = $4
              AND status = 'ACTIVE' AND email_verified = true`,
          [
            verification.new_email,
            verification.new_email_key,
            verification.account_id,
            verification.old_email_key,
          ],
        );
        if (!updated.rowCount)
          throw new BadRequestException('email change is no longer available');
        await client.query(
          `UPDATE public.identity_email_change
              SET completed_at = clock_timestamp()
            WHERE id = $1 AND completed_at IS NULL AND canceled_at IS NULL`,
          [verification.change_id],
        );
        await this.queueEmail(
          client,
          verification.change_id,
          verification.account_id,
          'participant-email-change-complete-old.v1',
          verification.display_name,
        );
        await this.queueEmail(
          client,
          verification.change_id,
          verification.account_id,
          'participant-email-change-complete-new.v1',
          verification.display_name,
        );
        await writeSecurityEvent(client, 'identity.email-change.completed.v1', {
          accountId: verification.account_id,
        });
        status = 'email_changed';
      }
      await client.query('COMMIT');
      return { status };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (isUniqueViolation(error))
        throw new BadRequestException('email change is no longer available');
      throw error;
    } finally {
      client.release();
    }
  }

  async resolveDelivery(
    accountId: string,
    templateId: string,
    changeId: string,
  ): Promise<{
    deliverableAddress: string;
    templateData: Record<string, string>;
  }> {
    const definition = emailChangeTemplate(templateId);
    if (!definition || !isUuid(changeId))
      throw new NotFoundException('email change recipient is unavailable');
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{
        account_id: string;
        display_name: string;
        old_email: string;
        new_email: string;
        expires_at: Date;
        canceled_at: Date | null;
        completed_at: Date | null;
      }>(
        `SELECT c.account_id, a.display_name, c.old_email::text AS old_email,
                c.new_email::text AS new_email, c.expires_at,
                c.canceled_at, c.completed_at
           FROM public.identity_email_change c
           JOIN public.account a ON a.id = c.account_id
          WHERE c.id = $1 AND c.account_id = $2 AND a.status = 'ACTIVE'
          FOR UPDATE OF c`,
        [changeId, accountId],
      );
      const change = result.rows[0];
      if (
        !change ||
        change.canceled_at ||
        (definition.phase === 'verify' &&
          (change.completed_at || change.expires_at <= new Date())) ||
        (definition.phase === 'complete' && !change.completed_at)
      )
        throw new NotFoundException('email change recipient is unavailable');
      let templateData: Record<string, string> = {
        displayName: change.display_name,
      };
      if (definition.phase === 'verify') {
        const token = randomBytes(32).toString('base64url');
        const addressKind = definition.addressKind;
        await client.query(
          `INSERT INTO public.identity_email_change_token
             (token_hash, change_id, address_kind, expires_at)
           VALUES ($1, $2, $3,
                   least($4::timestamptz,
                         clock_timestamp() + ($5 * interval '1 second')))`,
          [
            createHash('sha256').update(token).digest('hex'),
            changeId,
            addressKind,
            change.expires_at,
            TOKEN_TTL_SECONDS,
          ],
        );
        templateData = {
          ...templateData,
          confirmationUrl: participantEmailChangeUrl(token),
        };
      }
      await client.query('COMMIT');
      return {
        deliverableAddress:
          definition.addressKind === 'old'
            ? change.old_email
            : change.new_email,
        templateData,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async queueEmail(
    client: PoolClient,
    changeId: string,
    accountId: string,
    templateId: string,
    displayName: string,
  ) {
    const requestId = randomUUID();
    await writeOutboxEvent(client, {
      eventType: 'email.send.v1',
      aggregateType: 'email_delivery_intent',
      aggregateId: requestId,
      payload: {
        requestId,
        recipientAccountId: accountId,
        templateId,
        templateData: { changeId, displayName },
      },
    });
  }

  private async connect(): Promise<PoolClient> {
    if (!this.pool)
      throw new ServiceUnavailableException(
        'Identity database is not configured',
      );
    try {
      return await this.pool.connect();
    } catch {
      throw new ServiceUnavailableException('Identity database is unavailable');
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new BadRequestException('email change details are invalid');
  return value as Record<string, unknown>;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}

function emailChangeTemplate(templateId: string) {
  const match =
    /^participant-email-change-(old|new|complete-old|complete-new)\.v1$/.exec(
      templateId,
    );
  if (!match) return null;
  const value = match[1];
  return value === 'old' || value === 'new'
    ? { phase: 'verify' as const, addressKind: value }
    : {
        phase: 'complete' as const,
        addressKind: value.endsWith('old')
          ? ('old' as const)
          : ('new' as const),
      };
}

function participantEmailChangeUrl(token: string) {
  let base: URL;
  try {
    base = new URL(process.env.MYOTA_PARTICIPANT_PUBLIC_URL ?? '');
  } catch {
    throw new ServiceUnavailableException(
      'Participant email change is not configured',
    );
  }
  if (
    base.username ||
    base.password ||
    (base.protocol !== 'https:' &&
      !(
        base.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
      ))
  )
    throw new ServiceUnavailableException(
      'Participant email change is not configured',
    );
  base.hash = `emailChangeToken=${encodeURIComponent(token)}`;
  return base.toString();
}
