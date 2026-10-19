import {
  Inject,
  HttpException,
  HttpStatus,
  Injectable,
  ForbiddenException,
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { DEFAULT_ROLE_SCOPES } from './role-catalog.js';

const ACCESS_SECONDS = Number(process.env.MYOTA_ACCESS_TOKEN_SECONDS ?? 600);
const REFRESH_SECONDS = Number(
  process.env.MYOTA_REFRESH_TOKEN_SECONDS ?? 2_592_000,
);
const LOGIN_WINDOW_SECONDS = Number(
  process.env.MYOTA_LOGIN_WINDOW_SECONDS ?? 900,
);
const MAX_LOGIN_ATTEMPTS = Number(process.env.MYOTA_MAX_LOGIN_ATTEMPTS ?? 8);
const DEVELOPMENT_SIGNING_KEY = 'myota-development-key-change-me';

interface RequestContext {
  userAgent: string | null;
  remoteAddr: string | null;
}

interface AccountRow {
  id: string;
  display_name: string;
  email: string | null;
  participation_type: string;
  status: string;
  updated_at?: Date;
  password_hash: string | null;
  failed_attempts: number;
  locked_until: Date | null;
  website_url?: string | null;
  biography_markdown?: string | null;
  profile_image_id?: string | null;
  profile_image_media_type?: string | null;
  profile_image_updated_at?: Date | null;
}

interface AdminAccountRow extends AccountRow {
  created_at: Date;
  updated_at: Date;
  primary_callsign_id: string | null;
}

interface RoleAssignmentRow {
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
}

interface CallsignRow {
  accountId: string;
  id: string;
  value: string;
  status: string;
  verificationSource: string | null;
  verifiedAt: Date | null;
  validFrom: Date | null;
  validTo: Date | null;
  primary: boolean | null;
}

interface TokenClaims {
  sub: string;
  sid: string;
  jti: string;
  iat: number;
  exp: number;
  tokenType: 'access' | 'refresh';
}

@Injectable()
export class IdentityAuthService {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async login(
    input: { email: string; password: string },
    context: RequestContext,
  ): Promise<Record<string, unknown>> {
    const client = await this.connect();
    let failure: Error | undefined;
    try {
      await client.query('BEGIN');
      const normalizedEmail = input.email.trim().toLowerCase();
      const accountResult = await client.query<AccountRow>(
        `SELECT a.id, a.display_name, a.email::text AS email, a.updated_at,
                a.participation_type, a.status, c.password_hash,
                coalesce(c.failed_attempts, 0) AS failed_attempts, c.locked_until,
                p.website_url, p.biography_markdown, p.profile_image_id,
                p.profile_image_media_type, p.profile_image_updated_at
           FROM public.account a
           LEFT JOIN public.account_credential c ON c.account_id = a.id
           LEFT JOIN public.identity_account_profile p ON p.account_id = a.id
          WHERE lower(btrim(a.email::text)) = $1
          FOR UPDATE OF a`,
        [normalizedEmail],
      );
      const account = accountResult.rows[0];
      const globalOperator = account
        ? await this.hasGlobalOperator(client, account.id)
        : false;

      if (!globalOperator) {
        const rateKey = createHash('sha256')
          .update(`login:${normalizedEmail}:${context.remoteAddr ?? 'unknown'}`)
          .digest('hex');
        const limit = await client.query<{ request_count: number }>(
          `INSERT INTO public.identity_login_rate_limit
             (key_hash, window_started_at, request_count, expires_at)
           VALUES ($1, now(), 1, now() + ($2 * interval '1 second'))
           ON CONFLICT (key_hash) DO UPDATE SET
             window_started_at = CASE
               WHEN identity_login_rate_limit.expires_at <= now() THEN now()
               ELSE identity_login_rate_limit.window_started_at END,
             request_count = CASE
               WHEN identity_login_rate_limit.expires_at <= now() THEN 1
               ELSE identity_login_rate_limit.request_count + 1 END,
             expires_at = CASE
               WHEN identity_login_rate_limit.expires_at <= now()
                 THEN now() + ($2 * interval '1 second')
               ELSE identity_login_rate_limit.expires_at END,
             updated_at = now()
           RETURNING request_count`,
          [rateKey, LOGIN_WINDOW_SECONDS],
        );
        if (limit.rows[0].request_count > MAX_LOGIN_ATTEMPTS) {
          failure = new HttpException(
            'too many authentication attempts; try again later',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
      }

      if (
        !failure &&
        account?.locked_until &&
        account.locked_until > new Date()
      ) {
        failure = new UnauthorizedException('account temporarily locked');
      }

      const passwordOk =
        !failure &&
        account?.status === 'ACTIVE' &&
        account.password_hash !== null &&
        account.password_hash !== undefined &&
        (await verifyPassword(input.password, account.password_hash));

      if (!failure && !passwordOk) {
        if (account) {
          const failedAttempts = Number(account.failed_attempts) + 1;
          await client.query(
            `UPDATE public.account_credential
                SET failed_attempts = $2,
                    locked_until = CASE WHEN $2 >= 5
                      THEN now() + interval '900 seconds'
                      ELSE locked_until END
              WHERE account_id = $1`,
            [account.id, failedAttempts],
          );
        }
        await this.writeAudit(client, 'identity.login.failed.v1', {
          accountId: account?.id ?? null,
          email: input.email,
          remoteAddr: context.remoteAddr,
        });
        failure = new UnauthorizedException('invalid credentials');
      }

      if (!failure && account) {
        await client.query(
          `UPDATE public.account_credential
              SET failed_attempts = 0, locked_until = NULL
            WHERE account_id = $1`,
          [account.id],
        );
        await this.writeAudit(client, 'identity.login.succeeded.v1', {
          accountId: account.id,
          remoteAddr: context.remoteAddr,
        });
        const result = await this.createSession(client, account, context);
        await client.query('COMMIT');
        return result;
      }

      await client.query('COMMIT');
      throw failure ?? new UnauthorizedException('invalid credentials');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async refresh(
    token: string,
    context: RequestContext,
  ): Promise<Record<string, unknown>> {
    const claims = verifyToken(token, 'refresh');
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const sessionResult = await client.query(
        `SELECT id FROM public.auth_session
          WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL
            AND expires_at > now()
            AND refresh_token_hash = $3
          FOR UPDATE`,
        [
          claims.sid,
          claims.sub,
          createHash('sha256').update(token).digest('hex'),
        ],
      );
      if (!sessionResult.rowCount)
        throw new UnauthorizedException(
          'refresh session is invalid or revoked',
        );
      const accountResult = await client.query<AccountRow>(
        `SELECT a.id, a.display_name, a.email::text AS email, a.updated_at,
                a.participation_type, a.status, NULL::text AS password_hash,
                0 AS failed_attempts, NULL::timestamptz AS locked_until,
                p.website_url, p.biography_markdown, p.profile_image_id,
                p.profile_image_media_type, p.profile_image_updated_at
           FROM public.account a
           LEFT JOIN public.identity_account_profile p ON p.account_id = a.id
          WHERE a.id = $1 AND a.status = 'ACTIVE'
          FOR UPDATE OF a`,
        [claims.sub],
      );
      const account = accountResult.rows[0];
      if (!account)
        throw new UnauthorizedException('account is inactive or unavailable');
      await client.query(
        'UPDATE public.auth_session SET revoked_at = now() WHERE id = $1',
        [claims.sid],
      );
      const result = await this.createSession(client, account, context);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async requestRecovery(email: string): Promise<Record<string, unknown>> {
    const normalizedEmail = email.trim().toLowerCase();
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `DELETE FROM public.account_recovery_token
          WHERE used_at IS NOT NULL OR expires_at <= now()`,
      );
      const accountResult = await client.query<{ id: string }>(
        `SELECT id FROM public.account
          WHERE lower(btrim(email::text)) = $1`,
        [normalizedEmail],
      );
      const account = accountResult.rows[0];
      let devResetToken: string | undefined;
      if (account) {
        const token = randomBytes(32).toString('base64url');
        await client.query(
          `INSERT INTO public.account_recovery_token (token_hash, account_id, expires_at)
           VALUES ($1, $2, now() + ($3 * interval '1 second'))`,
          [
            createHash('sha256').update(token).digest('hex'),
            account.id,
            Number(process.env.MYOTA_RECOVERY_TOKEN_SECONDS ?? 1800),
          ],
        );
        await this.writeAudit(client, 'identity.recovery.requested.v1', {
          accountId: account.id,
        });
        if (
          process.env.MYOTA_ENV?.toLowerCase() !== 'production' ||
          process.env.MYOTA_EXPOSE_DEV_TOKENS === '1'
        ) {
          devResetToken = token;
        }
      }
      await client.query('COMMIT');
      return {
        status: 'accepted',
        ...(devResetToken ? { devResetToken } : {}),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async resetRecovery(
    token: string,
    newPassword: string,
  ): Promise<{ status: string }> {
    if (Array.from(newPassword).length < 12) {
      throw new BadRequestException(
        'password must contain at least 12 characters',
      );
    }
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const recoveryResult = await client.query<{ account_id: string }>(
        `SELECT account_id FROM public.account_recovery_token
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
          FOR UPDATE`,
        [tokenHash],
      );
      const recovery = recoveryResult.rows[0];
      if (!recovery) {
        throw new BadRequestException('recovery token is invalid or expired');
      }
      const passwordHash = await hashPassword(newPassword);
      await client.query(
        `INSERT INTO public.account_credential
           (account_id, password_hash, password_changed_at, failed_attempts, locked_until)
         VALUES ($1, $2, now(), 0, NULL)
         ON CONFLICT (account_id) DO UPDATE SET
           password_hash = EXCLUDED.password_hash,
           password_changed_at = EXCLUDED.password_changed_at,
           failed_attempts = 0,
           locked_until = NULL`,
        [recovery.account_id, passwordHash],
      );
      await client.query(
        `UPDATE public.account_recovery_token SET used_at = now()
          WHERE token_hash = $1`,
        [tokenHash],
      );
      await client.query(
        `UPDATE public.auth_session SET revoked_at = coalesce(revoked_at, now())
          WHERE account_id = $1 AND revoked_at IS NULL`,
        [recovery.account_id],
      );
      await this.writeAudit(client, 'identity.recovery.completed.v1', {
        accountId: recovery.account_id,
      });
      await client.query('COMMIT');
      return { status: 'password_reset' };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async logout(
    refreshToken?: string,
    authorization?: string,
  ): Promise<{ status: string }> {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      if (refreshToken) {
        try {
          const claims = verifyToken(refreshToken, 'refresh');
          const sessionHash = createHash('sha256')
            .update(refreshToken)
            .digest('hex');
          await client.query(
            `UPDATE public.auth_session SET revoked_at = coalesce(revoked_at, now())
              WHERE id = $1 AND refresh_token_hash = $2`,
            [claims.sid, sessionHash],
          );
          await client.query(
            `INSERT INTO public.auth_revocation (jti, expires_at)
             VALUES ($1, to_timestamp($2)) ON CONFLICT (jti) DO NOTHING`,
            [claims.jti, claims.exp],
          );
        } catch {
          // Logout is idempotent; malformed or expired refresh tokens are ignored.
        }
      }
      if (authorization?.startsWith('Bearer ')) {
        try {
          const claims = verifyToken(authorization.slice(7), 'access');
          await client.query(
            `INSERT INTO public.auth_revocation (jti, expires_at)
             VALUES ($1, to_timestamp($2)) ON CONFLICT (jti) DO NOTHING`,
            [claims.jti, claims.exp],
          );
        } catch {
          // Logout remains safe to repeat with an expired access token.
        }
      }
      await client.query('COMMIT');
      return { status: 'logged_out' };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async currentAccount(
    authorization: string,
  ): Promise<Record<string, unknown>> {
    if (!authorization.startsWith('Bearer ')) {
      throw new UnauthorizedException('Bearer authentication is required');
    }
    const claims = verifyToken(authorization.slice(7), 'access');
    const client = await this.connect();
    try {
      const revoked = await client.query(
        'SELECT 1 FROM public.auth_revocation WHERE jti = $1 AND expires_at > now()',
        [claims.jti],
      );
      if (revoked.rowCount)
        throw new UnauthorizedException('token has been revoked');
      const accountResult = await client.query<AccountRow>(
        `SELECT a.id, a.display_name, a.email::text AS email, a.updated_at,
                a.participation_type, a.status, NULL::text AS password_hash,
                0 AS failed_attempts, NULL::timestamptz AS locked_until,
                p.website_url, p.biography_markdown,
                p.profile_image_id, p.profile_image_media_type,
                p.profile_image_updated_at
           FROM public.account a
           LEFT JOIN public.identity_account_profile p ON p.account_id = a.id
          WHERE a.id = $1 AND a.status = 'ACTIVE'`,
        [claims.sub],
      );
      const account = accountResult.rows[0];
      if (!account)
        throw new UnauthorizedException('account is inactive or unavailable');
      const [roles, callsigns] = await Promise.all([
        this.loadRoles(client, account.id),
        this.loadCallsigns(client, account.id),
      ]);
      const scopes = effectiveScopes(roles);
      return {
        id: account.id,
        displayName: account.display_name,
        email: account.email,
        participationType: account.participation_type,
        status: account.status,
        updatedAt: account.updated_at,
        websiteUrl: account.website_url ?? null,
        biographyMarkdown: account.biography_markdown ?? null,
        profileImage: account.profile_image_id
          ? {
              id: account.profile_image_id,
              contentType: account.profile_image_media_type,
              width: 512,
              height: 512,
              updatedAt: account.profile_image_updated_at,
            }
          : null,
        callsigns,
        roles,
        scopes,
      };
    } finally {
      client.release();
    }
  }

  async listAdminAccounts(
    authorization: string,
    query: { q?: string; status?: string; page?: string; pageSize?: string },
  ): Promise<Record<string, unknown>> {
    const caller = await this.currentAccount(authorization);
    const scopes = new Set(caller.scopes as string[]);
    if (!scopes.has('*') && !scopes.has('identity.admin')) {
      throw new ForbiddenException('identity.admin scope is required');
    }
    const page = parsePage(query.page, 1);
    const pageSize = Math.min(100, parsePage(query.pageSize, 50));
    const search = (query.q ?? '').trim().toLowerCase();
    const status = query.status?.trim() || null;
    const client = await this.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const filter = `($1::text IS NULL OR a.status = $1)
        AND ($2 = '' OR coalesce(position($2 in lower(a.display_name)), 0) > 0
          OR coalesce(position($2 in lower(a.email::text)), 0) > 0)`;
      const params = [status, search];
      const totalResult = await client.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM public.account a WHERE ${filter}`,
        params,
      );
      const accountResult = await client.query<AdminAccountRow>(
        `SELECT a.id, a.display_name, a.email::text AS email,
                a.participation_type, a.status, a.created_at, a.updated_at,
                NULL::text AS password_hash, 0 AS failed_attempts,
                NULL::timestamptz AS locked_until,
                p.website_url, p.biography_markdown, p.profile_image_id,
                p.profile_image_media_type, p.profile_image_updated_at,
                primary_call.callsign_id AS primary_callsign_id
           FROM public.account a
           LEFT JOIN public.identity_account_profile p ON p.account_id = a.id
           LEFT JOIN public.account_primary_callsign primary_call
             ON primary_call.account_id = a.id
          WHERE ${filter}
          ORDER BY a.created_at, a.id
          LIMIT $3 OFFSET $4`,
        [...params, pageSize, (page - 1) * pageSize],
      );
      const accountIds = accountResult.rows.map((account) => account.id);
      const [rolesByAccount, callsignsByAccount] = await Promise.all([
        this.loadRolesForAccounts(client, accountIds),
        this.loadCallsignsForAccounts(client, accountIds),
      ]);
      const items = accountResult.rows.map((account) => {
        const roles = rolesByAccount.get(account.id) ?? [];
        return {
          id: account.id,
          displayName: account.display_name,
          email: account.email,
          participationType: account.participation_type,
          status: account.status,
          websiteUrl: account.website_url ?? null,
          biographyMarkdown: account.biography_markdown ?? null,
          profileImage: profileImageFor(account),
          createdAt: account.created_at,
          updatedAt: account.updated_at,
          primaryCallsignId: account.primary_callsign_id,
          callsigns: callsignsByAccount.get(account.id) ?? [],
          roles,
          scopes: effectiveScopes(roles),
        };
      });
      await client.query('COMMIT');
      const total = Number(totalResult.rows[0]?.total ?? 0);
      return {
        items,
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

  async updateOwnProfile(
    authorization: string,
    body: { websiteUrl?: string | null; biographyMarkdown?: string | null },
  ): Promise<Record<string, unknown>> {
    if (!authorization.startsWith('Bearer ')) {
      throw new UnauthorizedException('Bearer authentication is required');
    }
    if (Object.keys(body).length === 0) {
      throw new BadRequestException('profile update must include a field');
    }
    const values = { ...body };
    if ('websiteUrl' in values) {
      values.websiteUrl = validateWebsiteUrl(values.websiteUrl);
    }
    if ('biographyMarkdown' in values) {
      const biography = values.biographyMarkdown;
      if (biography !== null && typeof biography !== 'string') {
        throw new BadRequestException(
          'biographyMarkdown must be a string or null',
        );
      }
      if (
        typeof biography === 'string' &&
        Array.from(biography).length > 2000
      ) {
        throw new BadRequestException(
          'biographyMarkdown exceeds 2000 characters',
        );
      }
      values.biographyMarkdown = biography === '' ? null : biography;
    }

    const claims = verifyToken(authorization.slice(7), 'access');
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const accountResult = await client.query<AccountRow>(
        `SELECT a.id, a.display_name, a.email::text AS email, a.updated_at,
                a.participation_type, a.status, NULL::text AS password_hash,
                0 AS failed_attempts, NULL::timestamptz AS locked_until,
                p.website_url, p.biography_markdown, p.profile_image_id,
                p.profile_image_media_type, p.profile_image_updated_at
           FROM public.account a
           LEFT JOIN public.identity_account_profile p ON p.account_id = a.id
          WHERE a.id = $1 AND a.status = 'ACTIVE'
          FOR UPDATE OF a`,
        [claims.sub],
      );
      const account = accountResult.rows[0];
      if (!account)
        throw new UnauthorizedException('account is inactive or unavailable');
      const revoked = await client.query(
        'SELECT 1 FROM public.auth_revocation WHERE jti = $1 AND expires_at > now()',
        [claims.jti],
      );
      if (revoked.rowCount)
        throw new UnauthorizedException('token has been revoked');

      await client.query(
        `INSERT INTO public.identity_account_profile
           (account_id, website_url, biography_markdown)
         VALUES ($1, $2, $3)
         ON CONFLICT (account_id) DO UPDATE SET
           website_url = CASE WHEN $4 THEN EXCLUDED.website_url
                              ELSE identity_account_profile.website_url END,
           biography_markdown = CASE WHEN $5 THEN EXCLUDED.biography_markdown
                                     ELSE identity_account_profile.biography_markdown END`,
        [
          claims.sub,
          values.websiteUrl ?? null,
          values.biographyMarkdown ?? null,
          'websiteUrl' in values,
          'biographyMarkdown' in values,
        ],
      );
      await client.query(
        'UPDATE public.account SET updated_at = now() WHERE id = $1',
        [claims.sub],
      );
      const updated = await client.query(
        `SELECT p.website_url, p.biography_markdown, a.updated_at
           FROM public.account a
           LEFT JOIN public.identity_account_profile p ON p.account_id = a.id
          WHERE a.id = $1`,
        [claims.sub],
      );
      await client.query('COMMIT');
      return {
        id: account.id,
        displayName: account.display_name,
        email: account.email,
        participationType: account.participation_type,
        status: account.status,
        updatedAt: updated.rows[0]?.updated_at,
        websiteUrl: updated.rows[0]?.website_url ?? null,
        biographyMarkdown: updated.rows[0]?.biography_markdown ?? null,
        profileImage: profileImageFor(account),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async createSession(
    client: PoolClient,
    account: AccountRow,
    context: RequestContext,
  ): Promise<Record<string, unknown>> {
    const roles = await this.loadRoles(client, account.id);
    const scopes = effectiveScopes(roles);
    const sessionId = randomUUID();
    const accessJti = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const accessToken = signToken(
      {
        sub: account.id,
        sid: sessionId,
        jti: accessJti,
        scp: scopes,
        iat: now,
        exp: now + ACCESS_SECONDS,
        tokenType: 'access',
        roles,
      },
      'access',
    );
    const refreshToken = signToken(
      {
        sub: account.id,
        sid: sessionId,
        jti: randomUUID(),
        iat: now,
        exp: now + REFRESH_SECONDS,
        tokenType: 'refresh',
      },
      'refresh',
    );
    await client.query(
      `INSERT INTO public.auth_session
         (id, account_id, refresh_token_hash, access_jti, expires_at, user_agent, remote_addr)
       VALUES ($1, $2, $3, $4, to_timestamp($5), $6, $7)`,
      [
        sessionId,
        account.id,
        createHash('sha256').update(refreshToken).digest('hex'),
        accessJti,
        now + REFRESH_SECONDS,
        context.userAgent,
        isIpAddress(context.remoteAddr) ? context.remoteAddr : null,
      ],
    );
    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: ACCESS_SECONDS,
      account: {
        id: account.id,
        displayName: account.display_name,
        email: account.email,
        participationType: account.participation_type,
        status: account.status,
        updatedAt: account.updated_at,
        websiteUrl: account.website_url ?? null,
        biographyMarkdown: account.biography_markdown ?? null,
        profileImage: profileImageFor(account),
      },
    };
  }

  private async loadRoles(client: PoolClient, accountId: string) {
    const roles = await this.loadRolesForAccounts(client, [accountId]);
    return roles.get(accountId) ?? [];
  }

  private async loadRolesForAccounts(client: PoolClient, accountIds: string[]) {
    const resultMap = new Map<string, RoleAssignmentRow[]>(
      accountIds.map((accountId) => [accountId, []]),
    );
    if (accountIds.length === 0) return resultMap;
    const result = await client.query<RoleAssignmentRow>(
      `SELECT ar.account_id AS "accountId", ar.id,
              ar.role_code AS role, ar.programme_id AS "programmeId",
              p.slug AS "programmeSlug", ar.jurisdiction_id AS "jurisdictionId",
              j.code AS "jurisdiction", ar.entity_type_code AS "entityType",
              coalesce(rd.scopes, ARRAY(SELECT jsonb_array_elements_text(ar.scopes))) AS scopes,
              ar.created_at AS "createdAt", ar.valid_to AS "validTo"
         FROM public.account_role ar
         LEFT JOIN public.identity_role_definition rd ON rd.role_code = ar.role_code
         LEFT JOIN public.programme p ON p.id = ar.programme_id
         LEFT JOIN public.jurisdiction j ON j.id = ar.jurisdiction_id
        WHERE ar.account_id = ANY($1::uuid[])
          AND (ar.valid_to IS NULL OR ar.valid_to > now())
        ORDER BY ar.created_at, ar.id`,
      [accountIds],
    );
    for (const row of result.rows) {
      resultMap.get(row.accountId)?.push({
        ...row,
        scopes: DEFAULT_ROLE_SCOPES[row.role] ?? row.scopes,
      });
    }
    return resultMap;
  }

  private async loadCallsigns(client: PoolClient, accountId: string) {
    const callsigns = await this.loadCallsignsForAccounts(client, [accountId]);
    return callsigns.get(accountId) ?? [];
  }

  private async loadCallsignsForAccounts(
    client: PoolClient,
    accountIds: string[],
  ) {
    const resultMap = new Map<string, CallsignRow[]>(
      accountIds.map((accountId) => [accountId, []]),
    );
    if (accountIds.length === 0) return resultMap;
    const result = await client.query<CallsignRow>(
      `SELECT c.account_id AS "accountId", c.id, c.value,
              c.lifecycle_status AS status, c.verification_source AS "verificationSource",
              c.verified_at AS "verifiedAt", c.valid_from AS "validFrom",
              c.valid_to AS "validTo", (primary_call.callsign_id = c.id) AS "primary"
         FROM public.callsign c
         LEFT JOIN public.account_primary_callsign primary_call
           ON primary_call.account_id = c.account_id
        WHERE c.account_id = ANY($1::uuid[])
          AND (c.valid_to IS NULL OR c.valid_to > now())
        ORDER BY c.valid_from NULLS FIRST, c.value`,
      [accountIds],
    );
    for (const row of result.rows) {
      resultMap.get(row.accountId)?.push(row);
    }
    return resultMap;
  }

  private async hasGlobalOperator(
    client: PoolClient,
    accountId: string,
  ): Promise<boolean> {
    const result = await client.query(
      `SELECT 1 FROM public.account_role
        WHERE account_id = $1 AND role_code = 'GLOBAL_OPERATOR'
          AND (valid_to IS NULL OR valid_to > now()) LIMIT 1`,
      [accountId],
    );
    return Boolean(result.rowCount);
  }

  private async writeAudit(
    client: PoolClient,
    eventType: string,
    payload: Record<string, unknown>,
  ) {
    await client.query(
      `INSERT INTO public.audit_event (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('account', $1, $2, $3::jsonb)`,
      [payload.accountId ?? randomUUID(), eventType, JSON.stringify(payload)],
    );
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

function effectiveScopes(roles: RoleAssignmentRow[]) {
  const result = new Set(['identity.me']);
  for (const role of roles) {
    for (const scope of role.scopes ?? []) {
      if (scope !== 'operations.read') result.add(scope);
    }
    if (role.programmeSlug) {
      result.add(`programme:${role.programmeSlug}:${role.role.toLowerCase()}`);
    }
  }
  return [...result].sort();
}

function profileImageFor(account: AccountRow) {
  return account.profile_image_id
    ? {
        id: account.profile_image_id,
        contentType: account.profile_image_media_type,
        width: 512,
        height: 512,
        updatedAt: account.profile_image_updated_at,
      }
    : null;
}

function validateWebsiteUrl(value: string | null | undefined): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new BadRequestException('websiteUrl must be a string or null');
  }
  const website = value.trim();
  if (Array.from(website).length > 2048) {
    throw new BadRequestException('websiteUrl is invalid or too long');
  }
  for (const character of website) {
    if (
      character.charCodeAt(0) < 0x20 ||
      character.charCodeAt(0) === 0x7f ||
      /\s/u.test(character)
    ) {
      throw new BadRequestException('websiteUrl is invalid or too long');
    }
  }
  try {
    const parsed = new URL(website);
    if (
      !['http:', 'https:'].includes(parsed.protocol.toLowerCase()) ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error('unsupported URL');
    }
    return website.replace(/^[^:]+:/, parsed.protocol);
  } catch {
    throw new BadRequestException(
      'websiteUrl must be an HTTP or HTTPS URL without credentials',
    );
  }
}

async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const [scheme, saltText, expectedText, ...rest] = encoded.split('$');
  if (scheme !== 'scrypt' || !saltText || !expectedText || rest.length)
    return false;
  try {
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(expectedText, 'base64url');
    const actual = await new Promise<Buffer>((resolve, reject) => {
      scrypt(
        password,
        salt,
        expected.length,
        { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
        (error, derivedKey) => (error ? reject(error) : resolve(derivedKey)),
      );
    });
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  } catch {
    return false;
  }
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      salt,
      64,
      { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

function signToken(
  claims: TokenClaims | Record<string, unknown>,
  tokenType: 'access' | 'refresh',
) {
  const key = authSigningKey();
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT', tokenType }),
  ).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', key)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

function verifyToken(
  token: string,
  expectedType: 'access' | 'refresh',
): TokenClaims {
  try {
    const [headerPart, bodyPart, signaturePart, ...extra] = token.split('.');
    if (!headerPart || !bodyPart || !signaturePart || extra.length)
      throw new Error();
    const header = JSON.parse(
      Buffer.from(headerPart, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    const claims = JSON.parse(
      Buffer.from(bodyPart, 'base64url').toString('utf8'),
    ) as TokenClaims;
    const expected = createHmac('sha256', authSigningKey())
      .update(`${headerPart}.${bodyPart}`)
      .digest();
    const received = Buffer.from(signaturePart, 'base64url');
    if (
      header.alg !== 'HS256' ||
      header.tokenType !== expectedType ||
      received.length !== expected.length ||
      !timingSafeEqual(received, expected) ||
      claims.tokenType !== expectedType ||
      !claims.sub ||
      !claims.sid ||
      !claims.jti ||
      !Number.isFinite(claims.exp) ||
      claims.exp <= Math.floor(Date.now() / 1000)
    )
      throw new Error();
    return claims;
  } catch {
    throw new UnauthorizedException('invalid or expired token');
  }
}

function authSigningKey(): string {
  const value = process.env.MYOTA_AUTH_SIGNING_KEY ?? DEVELOPMENT_SIGNING_KEY;
  if (
    process.env.MYOTA_ENV?.toLowerCase() === 'production' &&
    value === DEVELOPMENT_SIGNING_KEY
  ) {
    throw new Error('MYOTA_AUTH_SIGNING_KEY must be set outside development');
  }
  return value;
}

function isIpAddress(value: string | null): boolean {
  return (
    value !== null && /^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+$/i.test(value)
  );
}

function parsePage(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new BadRequestException('page and pageSize must be integers');
  }
  return Math.max(1, parsed);
}
