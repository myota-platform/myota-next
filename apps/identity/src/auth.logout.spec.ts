import { createHash, createHmac } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { IdentityAuthService } from './auth.service.js';

describe('IdentityAuthService logout compatibility', () => {
  const accountId = '55555555-5555-4555-8555-555555555555';
  const signingKey = 'identity-logout-test-key';
  let originalSigningKey: string | undefined;

  beforeEach(() => {
    originalSigningKey = process.env.MYOTA_AUTH_SIGNING_KEY;
    process.env.MYOTA_AUTH_SIGNING_KEY = signingKey;
  });

  afterEach(() => {
    if (originalSigningKey === undefined)
      delete process.env.MYOTA_AUTH_SIGNING_KEY;
    else process.env.MYOTA_AUTH_SIGNING_KEY = originalSigningKey;
  });

  it('revokes the refresh session and the presented access token', async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    let refreshSessionRevoked = false;
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        statements.push({ sql, values });
        if (
          sql.includes('UPDATE public.auth_session SET revoked_at') &&
          sql.includes('refresh_token_hash')
        ) {
          refreshSessionRevoked = true;
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('SELECT id FROM public.auth_session'))
          return {
            rows: refreshSessionRevoked ? [] : [{ id: 'refresh-session-id' }],
            rowCount: refreshSessionRevoked ? 0 : 1,
          };
        if (sql.includes('FROM public.auth_revocation'))
          return { rows: [], rowCount: 0 };
        if (
          sql.includes(
            "FROM public.account WHERE id = $1 AND status = 'ACTIVE'",
          )
        )
          return { rows: [{ id: accountId }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
      release: () => undefined,
    } as unknown as PoolClient;
    const service = new IdentityAuthService({
      connect: async () => client,
    } as unknown as Pool);
    const now = Math.floor(Date.now() / 1000);
    const refreshToken = signedToken(
      'refresh',
      {
        sub: accountId,
        sid: 'refresh-session-id',
        jti: 'refresh-token-id',
        iat: now,
        exp: now + 300,
      },
      signingKey,
    );
    const accessToken = signedToken(
      'access',
      {
        sub: accountId,
        sid: 'refresh-session-id',
        jti: 'access-token-id',
        iat: now,
        exp: now + 300,
      },
      signingKey,
    );

    await expect(
      service.logout(refreshToken, `Bearer ${accessToken}`),
    ).resolves.toEqual({ status: 'logged_out' });

    const sessionRevocation = statements.find((statement) =>
      statement.sql.includes('UPDATE public.auth_session SET revoked_at'),
    );
    expect(sessionRevocation?.values).toEqual([
      'refresh-session-id',
      createHash('sha256').update(refreshToken).digest('hex'),
    ]);
    const revokedTokens = statements
      .filter((statement) =>
        statement.sql.includes('INSERT INTO public.auth_revocation'),
      )
      .map((statement) => statement.values[0]);
    expect(revokedTokens).toEqual(['refresh-token-id', 'access-token-id']);
    expect(statements.some((statement) => statement.sql === 'COMMIT')).toBe(
      true,
    );
    await expect(
      service.refresh(refreshToken, { userAgent: null, remoteAddr: null }),
    ).rejects.toThrow('refresh session is invalid or revoked');
    expect(statements.at(-1)?.sql).toBe('ROLLBACK');
  });

  it('treats an invalid refresh token as an idempotent logout', async () => {
    const statements: string[] = [];
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    } as unknown as PoolClient;
    const service = new IdentityAuthService({
      connect: async () => client,
    } as unknown as Pool);

    await expect(service.logout('not-a-token')).resolves.toEqual({
      status: 'logged_out',
    });
    expect(statements).toEqual(['BEGIN', 'COMMIT']);
  });
});

function signedToken(
  tokenType: 'access' | 'refresh',
  claims: {
    sub: string;
    sid: string;
    jti: string;
    iat: number;
    exp: number;
  },
  signingKey: string,
) {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT', tokenType }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ ...claims, tokenType }),
  ).toString('base64url');
  const signature = createHmac('sha256', signingKey)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}
