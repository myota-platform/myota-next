import type { Pool, PoolClient } from 'pg';
import type { IdentityAuthService } from './auth.service.js';
import type { IdentityRoleService } from './identity-role.service.js';
import type { IdentityProfileImageService } from './identity-profile-image.service.js';
import { IdentityAccountService } from './identity-account.service.js';

describe('IdentityAccountService session revocation parity', () => {
  const accountId = '11111111-1111-4111-8111-111111111111';

  async function updateAccount(body: Record<string, unknown>) {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const account = {
      id: accountId,
      display_name: 'Participant',
      email: 'participant@example.test',
      participation_type: 'OPERATOR',
      status: 'ACTIVE',
      website_url: null,
      biography_markdown: null,
      profile_image_id: null,
      profile_image_media_type: null,
      profile_image_updated_at: null,
      primary_callsign_id: null,
      created_at: new Date('2025-01-01T00:00:00.000Z'),
      updated_at: new Date('2025-01-01T00:00:00.000Z'),
    };
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.includes('FROM public.account a'))
          return { rows: [account], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    } as unknown as PoolClient;
    const pool = { connect: async () => client } as unknown as Pool;
    const auth = {
      currentAccount: async () => ({ id: 'admin-1', scopes: ['*'] }),
    } as unknown as IdentityAuthService;
    const service = new IdentityAccountService(
      pool,
      auth,
      {} as IdentityRoleService,
      {} as IdentityProfileImageService,
    );

    await service.updateAccount('Bearer admin', accountId, body);
    return queries;
  }

  it.each([
    ['admin password change', { password: 'Changed-password-123' }],
    ['account anonymization', { status: 'DEACTIVATED', anonymize: true }],
  ])('%s overwrites existing session revocation times', async (_name, body) => {
    const queries = await updateAccount(body);
    const sessionUpdate = queries.find((query) =>
      query.sql.includes('UPDATE public.auth_session SET revoked_at'),
    );

    expect(sessionUpdate?.sql).toContain('revoked_at = clock_timestamp()');
    expect(sessionUpdate?.sql).not.toContain('COALESCE');
    expect(sessionUpdate?.values).toEqual([accountId]);
  });

  it('does not revoke sessions for a status-only deactivation', async () => {
    const queries = await updateAccount({ status: 'DEACTIVATED' });

    expect(
      queries.some((query) =>
        query.sql.includes('UPDATE public.auth_session SET revoked_at'),
      ),
    ).toBe(false);
  });
});
