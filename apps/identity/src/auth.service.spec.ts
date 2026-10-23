import { createHmac } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { vi } from 'vitest';
import { IdentityAuthService } from './auth.service.js';

describe('Identity service token compatibility', () => {
  const service = new IdentityAuthService(null);
  let originalSigningKey: string | undefined;

  beforeEach(() => {
    originalSigningKey = process.env.MYOTA_AUTH_SIGNING_KEY;
    process.env.MYOTA_AUTH_SIGNING_KEY = 'test-auth-key';
  });

  afterEach(() => {
    if (originalSigningKey === undefined)
      delete process.env.MYOTA_AUTH_SIGNING_KEY;
    else process.env.MYOTA_AUTH_SIGNING_KEY = originalSigningKey;
  });

  it('matches the pinned Python HS256 service-token fixture', () => {
    const claims = {
      sub: 'service:test',
      jti: 'fixture-jti',
      scp: ['identity.email.resolve'],
      iat: 1_700_000_000,
      exp: 1_900_000_000,
      aud: 'myota-identity',
    };
    const token = service.signServiceToken(claims);

    expect(token).toBe(
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCIsInRva2VuVHlwZSI6InNlcnZpY2UifQ.eyJzdWIiOiJzZXJ2aWNlOnRlc3QiLCJqdGkiOiJmaXh0dXJlLWp0aSIsInNjcCI6WyJpZGVudGl0eS5lbWFpbC5yZXNvbHZlIl0sImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxOTAwMDAwMDAwLCJhdWQiOiJteW90YS1pZGVudGl0eSIsInRva2VuVHlwZSI6InNlcnZpY2UifQ.GfrJjbCeVPRdRopCqNsPbQhUrOe4SuBTDVLojXfyjOE',
    );
    expect(service.verifyServiceToken(`Bearer ${token}`)).toEqual({
      ...claims,
      tokenType: 'service',
    });
  });

  it('requires Bearer authentication and rejects tampered tokens', () => {
    expect(() => service.verifyServiceToken('Basic token')).toThrow(
      'Bearer authentication is required',
    );
    expect(() =>
      service.verifyServiceToken('Bearer invalid.token.value'),
    ).toThrow(UnauthorizedException);
  });

  it('rejects expired signed service tokens', () => {
    const token = service.signServiceToken({
      sub: 'service:test',
      jti: 'expired-fixture',
      scp: ['identity.email.resolve'],
      iat: 1_700_000_000,
      exp: 1,
    });

    expect(() => service.verifyServiceToken(`Bearer ${token}`)).toThrow(
      'invalid or expired token',
    );
  });

  it('recalculates current scopes from live role assignments', async () => {
    const accountId = '566b8475-bda2-4a2d-8ab8-d7a9a93c0041';
    const timestamp = new Date('2026-01-01T00:00:00Z');
    const client = {
      query: async (sql: string) => {
        if (sql.includes('auth_revocation')) return { rows: [], rowCount: 0 };
        if (sql.includes('FROM public.account a'))
          return {
            rows: [
              {
                id: accountId,
                display_name: 'Reader',
                email: null,
                created_at: timestamp,
                updated_at: timestamp,
                primary_callsign_id: null,
                participation_type: 'INDIVIDUAL',
                status: 'ACTIVE',
                website_url: null,
                biography_markdown: null,
                profile_image_id: null,
                profile_image_media_type: null,
                profile_image_updated_at: null,
              },
            ],
            rowCount: 1,
          };
        if (sql.includes('FROM public.account_role ar'))
          return {
            rows: [
              {
                accountId,
                id: 'role-assignment-1',
                role: 'CUSTOM_READER',
                programmeId: null,
                programmeSlug: null,
                jurisdictionId: null,
                jurisdiction: null,
                entityType: null,
                scopes: ['operations.read', 'observability.view'],
                createdAt: timestamp,
                validTo: null,
              },
            ],
            rowCount: 1,
          };
        if (sql.includes('FROM public.callsign c'))
          return { rows: [], rowCount: 0 };
        throw new Error(`unexpected query: ${sql}`);
      },
      release: () => undefined,
    };
    const pool = {
      connect: async () => client,
    };
    const auth = new IdentityAuthService(pool as never);
    const header = Buffer.from(
      JSON.stringify({ alg: 'HS256', typ: 'JWT', tokenType: 'access' }),
    ).toString('base64url');
    const claims = Buffer.from(
      JSON.stringify({
        sub: accountId,
        sid: 'session-1',
        jti: 'access-token-1',
        iat: 1_800_000_000,
        exp: 4_000_000_000,
        tokenType: 'access',
        scp: ['operations.read'],
      }),
    ).toString('base64url');
    const signingInput = `${header}.${claims}`;
    const signature = createHmac('sha256', 'test-auth-key')
      .update(signingInput)
      .digest('base64url');

    const account = await auth.currentAccount(
      `Bearer ${signingInput}.${signature}`,
    );

    expect(account.scopes).toEqual(['identity.me', 'observability.view']);
    expect(account.scopes).not.toContain('operations.read');
  });

  it('rejects an access token after its account is deactivated', async () => {
    const accountId = '566b8475-bda2-4a2d-8ab8-d7a9a93c0041';
    const statements: string[] = [];
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes('auth_revocation')) return { rows: [], rowCount: 0 };
        if (sql.includes('FROM public.account a'))
          return { rows: [], rowCount: 0 };
        throw new Error(`unexpected query: ${sql}`);
      },
      release: () => undefined,
    };
    const auth = new IdentityAuthService({
      connect: async () => client,
    } as never);
    const header = Buffer.from(
      JSON.stringify({ alg: 'HS256', typ: 'JWT', tokenType: 'access' }),
    ).toString('base64url');
    const claims = Buffer.from(
      JSON.stringify({
        sub: accountId,
        sid: 'session-1',
        jti: 'access-token-1',
        iat: 1_800_000_000,
        exp: 4_000_000_000,
        tokenType: 'access',
        scp: ['identity.accounts.create'],
      }),
    ).toString('base64url');
    const signingInput = `${header}.${claims}`;
    const signature = createHmac('sha256', 'test-auth-key')
      .update(signingInput)
      .digest('base64url');

    await expect(
      auth.currentAccount(`Bearer ${signingInput}.${signature}`),
    ).rejects.toThrow('account is inactive or unavailable');
    expect(
      statements.find((sql) => sql.includes('FROM public.account a')),
    ).toContain("a.status = 'ACTIVE'");
  });

  it('returns identity-resolved effective scopes in the Admin account list', async () => {
    const accountId = '566b8475-bda2-4a2d-8ab8-d7a9a93c0041';
    const timestamp = '2026-01-01T00:00:00.000000Z';
    const client = {
      query: async (sql: string) => {
        if (sql.includes('WITH matching AS MATERIALIZED'))
          return { rows: [{ id: accountId, total: '1' }], rowCount: 1 };
        if (sql.includes('FROM public.account a'))
          return {
            rows: [
              {
                id: accountId,
                display_name: 'Global operator',
                email: 'root@example.test',
                participation_type: 'OPERATOR',
                status: 'ACTIVE',
                created_at: timestamp,
                updated_at: timestamp,
                profile_image_id: null,
                profile_image_media_type: null,
                profile_image_updated_at: null,
                primary_callsign_id: null,
              },
            ],
            rowCount: 1,
          };
        if (sql.includes('FROM public.account_role ar'))
          return {
            rows: [
              {
                accountId,
                id: 'role-assignment-1',
                role: 'GLOBAL_OPERATOR',
                programmeId: null,
                programmeSlug: null,
                jurisdictionId: null,
                jurisdiction: null,
                entityType: null,
                scopes: ['*'],
                createdAt: timestamp,
                validTo: null,
              },
            ],
            rowCount: 1,
          };
        if (sql.includes('FROM public.callsign c'))
          return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    };
    const auth = new IdentityAuthService({
      connect: async () => client,
    } as never);
    vi.spyOn(auth, 'currentAccount').mockResolvedValue({
      id: 'admin-1',
      scopes: ['*'],
    } as never);

    const result = await auth.listAdminAccounts('Bearer admin', {});

    expect(result).toMatchObject({
      total: 1,
      items: [
        {
          id: accountId,
          roles: [{ role: 'GLOBAL_OPERATOR', scopes: ['*'] }],
          scopes: ['*', 'identity.me'],
        },
      ],
    });
  });
});
