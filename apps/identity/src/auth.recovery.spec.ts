import { BadRequestException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { IdentityAuthService } from './auth.service.js';

describe('IdentityAuthService recovery compatibility', () => {
  const accountId = '55555555-5555-4555-8555-555555555555';
  let originalEnvironment: string | undefined;

  beforeEach(() => {
    originalEnvironment = process.env.MYOTA_ENV;
    process.env.MYOTA_ENV = 'test';
  });

  afterEach(() => {
    if (originalEnvironment === undefined) delete process.env.MYOTA_ENV;
    else process.env.MYOTA_ENV = originalEnvironment;
  });

  function harness(accountExists = true, tokenExpired = false) {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    let recoveryTokenHash: string | undefined;
    let tokenUsed = false;
    let credentialHash: string | undefined;
    let sessionRevocationAccount: string | undefined;
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.includes('SELECT id FROM public.account')) {
          return {
            rows: accountExists ? [{ id: accountId }] : [],
            rowCount: accountExists ? 1 : 0,
          };
        }
        if (sql.includes('INSERT INTO public.account_recovery_token')) {
          recoveryTokenHash = String(values[0]);
          return { rows: [], rowCount: 1 };
        }
        if (
          sql.includes('SELECT account_id FROM public.account_recovery_token')
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

    const unknown = harness(false);
    expect(
      await unknown.service.requestRecovery('unknown@example.test'),
    ).toEqual({
      status: 'accepted',
    });
    expect(unknown.recoveryTokenHash).toBeUndefined();
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
      item.sql.includes('SELECT account_id FROM public.account_recovery_token'),
    );
    expect(tokenLookup?.sql).toContain('expires_at > now()');
    expect(fixture.tokenUsed).toBe(false);
    expect(fixture.credentialHash).toBeUndefined();
    expect(fixture.sessionRevocationAccount).toBeUndefined();
    expect(fixture.queries.at(-1)?.sql).toBe('ROLLBACK');
  });
});
