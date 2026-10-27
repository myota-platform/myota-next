import { BadRequestException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { IdentityAuthService } from './auth.service.js';

describe('IdentityAuthService recovery compatibility', () => {
  const accountId = '55555555-5555-4555-8555-555555555555';
  const originalEnvironment = {
    myotaEnv: process.env.MYOTA_ENV,
    publicUrl: process.env.MYOTA_PARTICIPANT_PUBLIC_URL,
    exposeTokens: process.env.MYOTA_EXPOSE_DEV_TOKENS,
  };

  beforeEach(() => {
    process.env.MYOTA_ENV = 'test';
    process.env.MYOTA_PARTICIPANT_PUBLIC_URL =
      'https://participant.example.test/';
    process.env.MYOTA_EXPOSE_DEV_TOKENS = '1';
  });

  afterEach(() => {
    if (originalEnvironment.myotaEnv === undefined)
      delete process.env.MYOTA_ENV;
    else process.env.MYOTA_ENV = originalEnvironment.myotaEnv;
    if (originalEnvironment.publicUrl === undefined)
      delete process.env.MYOTA_PARTICIPANT_PUBLIC_URL;
    else
      process.env.MYOTA_PARTICIPANT_PUBLIC_URL = originalEnvironment.publicUrl;
    if (originalEnvironment.exposeTokens === undefined)
      delete process.env.MYOTA_EXPOSE_DEV_TOKENS;
    else process.env.MYOTA_EXPOSE_DEV_TOKENS = originalEnvironment.exposeTokens;
  });

  function harness(
    accountExists = true,
    tokenExpired = false,
    rateLimitCount = 1,
  ) {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    let recoveryTokenHash: string | undefined;
    let tokenUsed = false;
    let credentialHash: string | undefined;
    let sessionRevocationAccount: string | undefined;
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.includes('SELECT id, display_name FROM public.account')) {
          return {
            rows: accountExists
              ? [{ id: accountId, display_name: 'Casey Operator' }]
              : [],
            rowCount: accountExists ? 1 : 0,
          };
        }
        if (sql.includes('INSERT INTO public.identity_registration_rate_limit'))
          return {
            rows: [{ request_count: rateLimitCount }],
            rowCount: 1,
          };
        if (
          sql.includes('INSERT INTO public.identity_password_recovery_request')
        )
          return { rows: [], rowCount: 1 };
        if (sql.includes('INSERT INTO public.account_recovery_token')) {
          recoveryTokenHash = String(values[0]);
          tokenUsed = false;
          return { rows: [], rowCount: 1 };
        }
        if (
          sql.includes('SELECT r.account_id FROM public.account_recovery_token')
        ) {
          const isValid =
            values[0] === recoveryTokenHash && !tokenUsed && !tokenExpired;
          return {
            rows: isValid ? [{ account_id: accountId }] : [],
            rowCount: isValid ? 1 : 0,
          };
        }
        if (sql.includes('INSERT INTO public.account_credential')) {
          credentialHash = String(values[1]);
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('UPDATE public.account_recovery_token SET used_at')) {
          tokenUsed = true;
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('UPDATE public.auth_session SET revoked_at')) {
          sessionRevocationAccount = String(values[0]);
          return { rows: [], rowCount: 2 };
        }
        if (sql.includes('INSERT INTO public.security_event')) {
          return {
            rows: [{ occurred_at: '2026-10-21T12:00:00.000000Z' }],
            rowCount: 1,
          };
        }
        if (sql.includes('INSERT INTO public.outbox_event')) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    } as unknown as PoolClient;
    const pool = { connect: async () => client } as unknown as Pool;
    return {
      service: new IdentityAuthService(pool),
      queries,
      get recoveryTokenHash() {
        return recoveryTokenHash;
      },
      get tokenUsed() {
        return tokenUsed;
      },
      get credentialHash() {
        return credentialHash;
      },
      get sessionRevocationAccount() {
        return sessionRevocationAccount;
      },
    };
  }

  it('returns a development token only for an existing account', async () => {
    const existing = harness();
    const result = await existing.service.requestRecovery('USER@example.test');

    expect(result.status).toBe('accepted');
    expect(result.devResetToken).toEqual(expect.any(String));
    expect(existing.recoveryTokenHash).toMatch(/^[0-9a-f]{64}$/);
    const emailOutbox = existing.queries.find(
      (item) =>
        item.sql.includes('INSERT INTO public.outbox_event') &&
        item.values[1] === 'email.send.v1',
    );
    const emailPayload = JSON.parse(String(emailOutbox?.values[5]));
    expect(emailPayload.templateData).toEqual({
      displayName: 'Casey Operator',
    });
    expect(JSON.stringify(emailPayload)).not.toContain(result.devResetToken);

    const unknown = harness(false);
    expect(
      await unknown.service.requestRecovery('unknown@example.test'),
    ).toEqual({
      status: 'accepted',
    });
    expect(unknown.recoveryTokenHash).toBeUndefined();
  });

  it('rate-limits password-reset email work while keeping the generic response', async () => {
    const limited = harness(true, false, 6);
    await expect(
      limited.service.requestRecovery('user@example.test', '192.0.2.14'),
    ).resolves.toEqual({ status: 'accepted' });
    expect(
      limited.queries.some((item) =>
        item.sql.includes('SELECT id, display_name FROM public.account'),
      ),
    ).toBe(false);
    expect(limited.recoveryTokenHash).toBeUndefined();
  });

  it('does not expose reset tokens outside explicit test mode', async () => {
    process.env.MYOTA_EXPOSE_DEV_TOKENS = '0';
    const result = await harness().service.requestRecovery('user@example.test');
    expect(result).toEqual({ status: 'accepted' });
  });

  it('binds queued reset email work to a persisted current request', async () => {
    const fixture = harness();
    await fixture.service.requestRecovery('user@example.test');
    const recoveryRequest = fixture.queries.find((item) =>
      item.sql.includes(
        'INSERT INTO public.identity_password_recovery_request',
      ),
    );
    const outbox = fixture.queries.find(
      (item) =>
        item.sql.includes('INSERT INTO public.outbox_event') &&
        item.values[1] === 'email.send.v1',
    );
    const payload = JSON.parse(String(outbox?.values[5]));
    expect(recoveryRequest?.values[0]).toBe(payload.requestId);
    expect(payload.templateData).toEqual({ displayName: 'Casey Operator' });
  });

  it('uses a recovery token once, enforces password length, and revokes all sessions', async () => {
    const fixture = harness();
    const { devResetToken } =
      await fixture.service.requestRecovery('user@example.test');
    if (typeof devResetToken !== 'string')
      throw new Error('missing test token');

    await expect(
      fixture.service.resetRecovery(devResetToken, 'short'),
    ).rejects.toThrow('password must contain at least 12 characters');
    expect(fixture.tokenUsed).toBe(false);
    expect(fixture.credentialHash).toBeUndefined();

    await expect(
      fixture.service.resetRecovery(
        devResetToken,
        'Updated Recovery Password 2026!',
      ),
    ).resolves.toEqual({ status: 'password_reset' });
    expect(fixture.tokenUsed).toBe(true);
    expect(fixture.credentialHash).toMatch(/^scrypt\$/);
    expect(fixture.sessionRevocationAccount).toBe(accountId);
    const sessionUpdate = fixture.queries.find((item) =>
      item.sql.includes('UPDATE public.auth_session SET revoked_at'),
    );
    expect(sessionUpdate?.sql).not.toContain('revoked_at IS NULL');
    const accessTokenRevocations = fixture.queries.find(
      (item) =>
        item.sql.includes('INSERT INTO public.auth_revocation') &&
        item.sql.includes('SELECT access_jti'),
    );
    expect(accessTokenRevocations?.sql).toContain(
      'WHERE account_id = $1 AND expires_at > now()',
    );
    expect(accessTokenRevocations?.values).toEqual([accountId]);

    await expect(
      fixture.service.resetRecovery(
        devResetToken,
        'Another Recovery Password 2026!',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an expired token without changing credentials or session state', async () => {
    const fixture = harness(true, true);
    const { devResetToken } =
      await fixture.service.requestRecovery('user@example.test');
    if (typeof devResetToken !== 'string')
      throw new Error('missing test token');

    await expect(
      fixture.service.resetRecovery(
        devResetToken,
        'Updated Recovery Password 2026!',
      ),
    ).rejects.toThrow('recovery token is invalid or expired');

    const tokenLookup = fixture.queries.find((item) =>
      item.sql.includes(
        'SELECT r.account_id FROM public.account_recovery_token',
      ),
    );
    expect(tokenLookup?.sql).toContain('expires_at > now()');
    expect(fixture.tokenUsed).toBe(false);
    expect(fixture.credentialHash).toBeUndefined();
    expect(fixture.sessionRevocationAccount).toBeUndefined();
    expect(fixture.queries.at(-1)?.sql).toBe('ROLLBACK');
  });
});
