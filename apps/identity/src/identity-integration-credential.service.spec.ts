import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { IdentityAuthService } from './auth.service.js';
import { IdentityCredentialService } from './identity-credential.service.js';
import { IdentityIntegrationService } from './identity-integration.service.js';

describe('Identity integration and credential services', () => {
  const accountId = '77777777-7777-4777-8777-777777777777';

  function database() {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const events: Array<{ type: string; payload: Record<string, unknown> }> =
      [];
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.includes('INSERT INTO public.identity_oidc_provider_mapping')) {
          return {
            rows: [
              {
                id: values[0],
                programme_slug: values[1],
                issuer: values[2],
                client_id: values[3],
                scopes: values[4],
                enabled: values[5],
                created_at: '2026-01-01T00:00:00.000000Z',
                updated_at: '2026-01-01T00:00:00.000000Z',
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('INSERT INTO public.security_event')) {
          events.push({
            type: String(values[2]),
            payload: JSON.parse(String(values[3])) as Record<string, unknown>,
          });
          return {
            rows: [{ occurred_at: '2026-01-01T00:00:00.000000Z' }],
            rowCount: 1,
          };
        }
        if (sql.includes('FROM public.auth_revocation')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('FROM public.account')) {
          return { rows: [{ email: 'operator@example.test' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
      release: () => undefined,
    } as unknown as PoolClient;
    const pool = { connect: async () => client } as unknown as Pool;
    return { pool, queries, events };
  }

  function auth(scopes: string[] = ['*']) {
    const signed: Array<Record<string, unknown>> = [];
    const verified = {
      jti: 'token-id',
      sub: 'service:email-service',
      aud: 'myota-identity',
      scp: ['identity.email.resolve'],
    };
    const service = {
      currentAccount: async () => ({ id: accountId, scopes }),
      signServiceToken: (claims: Record<string, unknown>) => {
        signed.push(claims);
        return 'signed-token';
      },
      verifyServiceToken: () => verified,
    } as unknown as IdentityAuthService;
    return { service, signed, verified };
  }

  it('validates required OIDC fields before authenticating and applies Python defaults', async () => {
    const db = database();
    const authFixture = auth();
    const authService = authFixture.service as unknown as {
      currentAccount: ReturnType<typeof vi.fn>;
    };
    const currentAccount = vi.fn(authService.currentAccount);
    authService.currentAccount = currentAccount;
    const service = new IdentityIntegrationService(
      db.pool,
      authFixture.service,
    );

    await expect(
      service.saveOidcMapping('Bearer token', {
        programmeSlug: '',
        issuer: 'https://issuer.example.test',
        clientId: 'client',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(currentAccount).not.toHaveBeenCalled();
    expect(db.queries).toHaveLength(0);

    const result = await service.saveOidcMapping('Bearer token', {
      programmeSlug: 'winter-field-day',
      issuer: 'https://issuer.example.test',
      clientId: 'client',
    });
    expect(result).toMatchObject({
      programmeSlug: 'winter-field-day',
      scopes: ['openid', 'profile', 'email'],
      enabled: true,
    });
    expect(db.events).toMatchObject([
      {
        type: 'identity.oidc.mapping.updated.v1',
        payload: { programmeSlug: 'winter-field-day', enabled: true },
      },
    ]);
    expect(db.queries.some(({ sql }) => sql === 'COMMIT')).toBe(true);
  });

  it('requires OIDC configuration scope before opening a database connection', async () => {
    const db = database();
    const service = new IdentityIntegrationService(db.pool, auth([]).service);
    await expect(
      service.saveOidcMapping('Bearer token', {
        programmeSlug: 'winter-field-day',
        issuer: 'https://issuer.example.test',
        clientId: 'client',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.queries).toHaveLength(0);
  });

  it('issues the restricted email service token and rejects caller-selected options', async () => {
    const db = database();
    const authFixture = auth();
    const priorSecret = process.env.MYOTA_EMAIL_SERVICE_CLIENT_SECRET;
    process.env.MYOTA_EMAIL_SERVICE_CLIENT_SECRET = 's'.repeat(40);
    const service = new IdentityCredentialService(db.pool, authFixture.service);
    const result = await service.issueServiceToken({
      service: 'email-service',
      clientSecret: 's'.repeat(40),
    });
    expect(result).toEqual({
      accessToken: 'signed-token',
      tokenType: 'Bearer',
      expiresIn: 300,
    });
    expect(authFixture.signed[0]).toMatchObject({
      sub: 'service:email-service',
      aud: 'myota-identity',
      scp: ['identity.email.resolve'],
      exp: expect.any(Number),
      iat: expect.any(Number),
      jti: expect.any(String),
    });
    expect(db.events[0]).toMatchObject({
      type: 'identity.service-token.issued.v1',
      payload: { service: 'email-service', scopes: ['identity.email.resolve'] },
    });
    await expect(
      service.issueServiceToken({
        service: 'email-service',
        clientSecret: 's'.repeat(40),
        scopes: ['identity.email.resolve'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    if (priorSecret === undefined) {
      delete process.env.MYOTA_EMAIL_SERVICE_CLIENT_SECRET;
    } else {
      process.env.MYOTA_EMAIL_SERVICE_CLIENT_SECRET = priorSecret;
    }
  });

  it('authorizes generic token issuance and reserves the email recipient scope', async () => {
    const db = database();
    const authFixture = auth(['identity.service.issue']);
    const service = new IdentityCredentialService(db.pool, authFixture.service);
    await expect(
      service.issueServiceToken(
        { service: 'activity-worker', scopes: ['identity.email.resolve'] },
        'Bearer actor',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.queries).toHaveLength(0);

    await service.issueServiceToken(
      { service: 'activity-worker', scopes: ['activity.read'] },
      'Bearer actor',
    );
    expect(authFixture.signed[0]).toMatchObject({
      sub: 'service:activity-worker',
      scp: ['activity.read'],
    });
    expect(db.events.at(-1)?.type).toBe('identity.service-token.issued.v1');
  });

  it('resolves an active account email only for the verified email service identity', async () => {
    const db = database();
    const authFixture = auth();
    const service = new IdentityCredentialService(db.pool, authFixture.service);
    await expect(
      service.resolveEmailRecipient('Bearer service-token', accountId),
    ).resolves.toEqual({ deliverableAddress: 'operator@example.test' });
    expect(
      db.queries.find(({ sql }) => sql.includes('FROM public.account'))?.values,
    ).toEqual([accountId]);

    authFixture.verified.sub = 'service:other';
    await expect(
      service.resolveEmailRecipient('Bearer service-token', accountId),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
