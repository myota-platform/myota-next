import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { writeOutboxEvent, writeSecurityEvent } from '@app/platform/outbox.js';
import { trimPythonWhitespace } from '@app/platform/python-strings.js';
import { unicodeCaseFold } from '@app/platform/unicode-casefold.js';
import { hashPassword } from './auth.service.js';

const GENERIC_RESPONSE =
  'If registration can proceed, a verification email will be sent.';
const RATE_WINDOW_SECONDS = 900;
const RATE_LIMIT = 5;
const TOKEN_TTL_SECONDS = 86_400;

@Injectable()
export class IdentityRegistrationService {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async register(
    rawBody: unknown,
    remoteAddr: string | null,
  ): Promise<{ message: string }> {
    const body = asRecord(rawBody);
    const displayName =
      typeof body.displayName === 'string'
        ? trimPythonWhitespace(body.displayName)
        : '';
    const emailInput =
      typeof body.email === 'string' ? trimPythonWhitespace(body.email) : '';
    const email = unicodeCaseFold(emailInput);
    const password = typeof body.password === 'string' ? body.password : '';
    const participationType = body.participationType ?? 'OPERATOR';
    if (
      Object.keys(body).some(
        (field) =>
          !['displayName', 'email', 'password', 'participationType'].includes(
            field,
          ),
      ) ||
      Array.from(displayName).length < 1 ||
      Array.from(displayName).length > 120 ||
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      Array.from(password).length < 12 ||
      Array.from(password).length > 128 ||
      (participationType !== 'OPERATOR' && participationType !== 'SWL')
    )
      throw new BadRequestException('registration details are invalid');
    return this.createOrResend(
      email,
      displayName,
      password,
      participationType,
      remoteAddr,
    );
  }

  async resend(
    rawBody: unknown,
    remoteAddr: string | null,
  ): Promise<{ message: string }> {
    const body = asRecord(rawBody);
    const emailInput =
      typeof body.email === 'string' ? trimPythonWhitespace(body.email) : '';
    const email = unicodeCaseFold(emailInput);
    if (
      Object.keys(body).some((field) => field !== 'email') ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254
    )
      throw new BadRequestException('email is invalid');
    await this.createOrResend(email, null, null, null, remoteAddr);
    return { message: GENERIC_RESPONSE };
  }

  async verify(rawBody: unknown): Promise<{ message: string }> {
    const body = asRecord(rawBody);
    const token = typeof body.token === 'string' ? body.token : '';
    if (
      Object.keys(body).some((field) => field !== 'token') ||
      !/^[A-Za-z0-9_-]{40,60}$/.test(token)
    )
      throw new BadRequestException('verification token is invalid or expired');
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const result = await client.query<{
        account_id: string;
        used_at: Date | null;
        expires_at: Date;
      }>(
        `SELECT account_id, used_at, expires_at
           FROM public.identity_email_verification_token
          WHERE token_hash = $1 FOR UPDATE`,
        [tokenHash],
      );
      const record = result.rows[0];
      if (!record || record.used_at || record.expires_at <= new Date())
        throw new BadRequestException(
          'verification token is invalid or expired',
        );
      await client.query(
        `UPDATE public.identity_email_verification_token
            SET used_at = clock_timestamp()
          WHERE token_hash = $1`,
        [tokenHash],
      );
      await client.query(
        `UPDATE public.account
            SET email_verified = true, status = 'ACTIVE',
                updated_at = clock_timestamp()
          WHERE id = $1 AND email_verified = false`,
        [record.account_id],
      );
      await writeSecurityEvent(client, 'identity.account.email-verified.v1', {
        accountId: record.account_id,
      });
      await client.query('COMMIT');
      return { message: 'Email verified. You can now sign in.' };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async createOrResend(
    email: string,
    displayName: string | null,
    password: string | null,
    participationType: string | null,
    remoteAddr: string | null,
  ): Promise<{ message: string }> {
    const participantUrl = process.env.MYOTA_PARTICIPANT_PUBLIC_URL?.trim();
    if (!participantUrl) {
      throw new ServiceUnavailableException(
        'Participant registration is not configured',
      );
    }
    let base: URL;
    try {
      base = new URL(participantUrl);
    } catch {
      throw new ServiceUnavailableException(
        'Participant registration is not configured',
      );
    }
    if (
      base.protocol !== 'https:' &&
      !(
        base.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
      )
    )
      throw new ServiceUnavailableException(
        'Participant registration is not configured',
      );
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      await this.incrementRateLimit(client, email, remoteAddr);
      const accountResult = await client.query<{
        id: string;
        display_name: string;
        email_verified: boolean;
      }>(
        `SELECT id, display_name, email_verified FROM public.account
          WHERE identity_email_key = $1 FOR UPDATE`,
        [email],
      );
      let account:
        | {
            id: string;
            display_name: string;
            email_verified: boolean;
            created_at?: string;
            updated_at?: string;
          }
        | undefined = accountResult.rows[0];
      if (!account && displayName && password && participationType) {
        const accountId = randomUUID();
        const inserted = await client.query<{
          id: string;
          display_name: string;
          created_at: string;
          updated_at: string;
        }>(
          `INSERT INTO public.account
             (id, display_name, email, identity_email_key,
              participation_type, status, email_verified)
           VALUES ($1, $2, $3::text::public.citext, $3, $4,
                   'PENDING_SETUP', false)
           RETURNING id, display_name,
             to_char(created_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
             to_char(updated_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at`,
          [accountId, displayName, email, participationType],
        );
        account = { ...inserted.rows[0], email_verified: false };
        await client.query(
          `INSERT INTO public.account_credential (account_id, password_hash)
           VALUES ($1, $2)`,
          [account.id, await hashPassword(password)],
        );
        await client.query(
          `INSERT INTO public.account_role
             (id, account_id, role_code, scopes)
           VALUES ($1, $2, 'PARTICIPANT', '[]'::jsonb)`,
          [randomUUID(), account.id],
        );
        await writeOutboxEvent(client, {
          eventType: 'identity.account.created.v1',
          aggregateType: 'account',
          aggregateId: account.id,
          payload: {
            source: 'public-registration',
            account: {
              id: account.id,
              displayName: account.display_name,
              email,
              participationType,
              status: 'PENDING_SETUP',
              callsigns: [],
              primaryCallsignId: null,
              createdAt: account.created_at!,
              updatedAt: account.updated_at!,
            },
          },
        });
      }
      if (account && !account.email_verified) {
        const token = randomBytes(32).toString('base64url');
        const tokenHash = createHash('sha256').update(token).digest('hex');
        await client.query(
          `UPDATE public.identity_email_verification_token
              SET used_at = coalesce(used_at, clock_timestamp())
            WHERE account_id = $1 AND used_at IS NULL`,
          [account.id],
        );
        await client.query(
          `INSERT INTO public.identity_email_verification_token
             (token_hash, account_id, expires_at)
           VALUES ($1, $2, clock_timestamp() + ($3 * interval '1 second'))`,
          [tokenHash, account.id, TOKEN_TTL_SECONDS],
        );
        const verificationUrl = new URL('/', base);
        verificationUrl.searchParams.set('token', token);
        const requestId = randomUUID();
        await writeOutboxEvent(client, {
          eventType: 'email.send.v1',
          aggregateType: 'email_delivery_intent',
          aggregateId: requestId,
          payload: {
            requestId,
            recipientAccountId: account.id,
            templateId: 'participant-email-verification.v1',
            templateData: {
              displayName: account.display_name,
              verificationUrl: verificationUrl.toString(),
            },
          },
        });
      }
      await client.query('COMMIT');
      return { message: GENERIC_RESPONSE };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (isUniqueViolation(error)) return { message: GENERIC_RESPONSE };
      throw error;
    } finally {
      client.release();
    }
  }

  private async incrementRateLimit(
    client: import('pg').PoolClient,
    email: string,
    remoteAddr: string | null,
  ) {
    const keyHash = createHash('sha256')
      .update(`register:${email}:${remoteAddr ?? 'unknown'}`)
      .digest('hex');
    const result = await client.query<{ request_count: number }>(
      `INSERT INTO public.identity_registration_rate_limit
         (key_hash, window_started_at, request_count, expires_at)
       VALUES ($1, clock_timestamp(), 1,
               clock_timestamp() + ($2 * interval '1 second'))
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
             THEN clock_timestamp() + ($2 * interval '1 second')
           ELSE identity_registration_rate_limit.expires_at END,
         updated_at = clock_timestamp()
       RETURNING request_count`,
      [keyHash, RATE_WINDOW_SECONDS],
    );
    if (result.rows[0].request_count > RATE_LIMIT)
      throw new BadRequestException(
        'too many registration requests; try again later',
      );
  }

  private async connect() {
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

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
