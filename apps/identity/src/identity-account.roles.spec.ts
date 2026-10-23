import { ForbiddenException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { IdentityAuthService } from './auth.service.js';
import type { IdentityProfileImageService } from './identity-profile-image.service.js';
import { IdentityAccountService } from './identity-account.service.js';
import type { IdentityRoleService } from './identity-role.service.js';
import { DEFAULT_ROLE_DEFINITIONS } from './role-catalog.js';

describe('IdentityAccountService role grant authorization', () => {
  const targetAccountId = '22222222-2222-4222-8222-222222222222';
  const identityAdminScopes = [
    'identity.accounts.create',
    'identity.admin',
    'identity.roles.assign',
    'identity.audit.read',
    'callsign.verify',
  ];

  function harness(scopes: string[] = identityAdminScopes) {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.includes('SELECT 1 FROM public.account')) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    } as unknown as PoolClient;
    const pool = { connect: async () => client } as unknown as Pool;
    const auth = {
      currentAccount: async () => ({
        id: 'identity-admin-1',
        scopes,
      }),
    } as unknown as IdentityAuthService;
    const roles = {
      readRoleDefinitionsForTransaction: async () => DEFAULT_ROLE_DEFINITIONS,
    } as unknown as IdentityRoleService;
    const service = new IdentityAccountService(
      pool,
      auth,
      roles,
      {} as IdentityProfileImageService,
    );
    return { service, queries };
  }

  it.each(['GIS_ADMIN', 'IDENTITY_ADMIN', 'GLOBAL_OPERATOR'])(
    'prevents an Identity administrator from granting %s',
    async (role) => {
      const fixture = harness();

      await expect(
        fixture.service.create('Bearer test', {
          displayName: 'New participant',
          email: `${role.toLowerCase()}@example.test`,
          participationType: 'SWL',
          roles: [{ code: role }],
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(fixture.queries.some((item) => item.sql === 'ROLLBACK')).toBe(
        true,
      );
      expect(
        fixture.queries.some((item) =>
          item.sql.includes('INSERT INTO public.account\n'),
        ),
      ).toBe(false);
    },
  );

  it('does not let a global operator grant the equal global role to a new account', async () => {
    const fixture = harness(['*']);

    await expect(
      fixture.service.create('Bearer global-operator', {
        displayName: 'New global operator',
        email: 'new-global@example.test',
        participationType: 'OPERATOR',
        roles: [{ code: 'GLOBAL_OPERATOR' }],
      }),
    ).rejects.toThrow(
      'actors may grant only roles strictly below their authority',
    );

    expect(fixture.queries).toContainEqual(
      expect.objectContaining({ sql: 'ROLLBACK' }),
    );
    expect(
      fixture.queries.some((item) =>
        item.sql.includes('INSERT INTO public.account\n'),
      ),
    ).toBe(false);
  });

  it('does not allow the last global operator role to be removed', async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const account = {
      id: targetAccountId,
      display_name: 'Last global operator',
      email: 'global@example.test',
      participation_type: 'OPERATOR',
      status: 'ACTIVE',
      website_url: null,
      biography_markdown: null,
      profile_image_id: null,
      profile_image_media_type: null,
      profile_image_updated_at: null,
      primary_callsign_id: null,
      created_at: '2026-01-01T00:00:00.000000Z',
      updated_at: '2026-01-01T00:00:00.000000Z',
    };
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.includes('FROM public.account a')) {
          return { rows: [account], rowCount: 1 };
        }
        if (sql.includes('SELECT role_code AS role')) {
          return {
            rows: [
              {
                role: 'GLOBAL_OPERATOR',
                programmeSlug: null,
                jurisdiction: null,
                entityType: null,
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('SELECT count(DISTINCT account_id)')) {
          return { rows: [{ count: '1' }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO public.security_event')) {
          return {
            rows: [{ occurred_at: '2026-01-02T00:00:00.000000Z' }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    } as unknown as PoolClient;
    const service = new IdentityAccountService(
      { connect: async () => client } as unknown as Pool,
      {
        currentAccount: async () => ({
          id: 'global-operator-1',
          scopes: ['*'],
        }),
      } as unknown as IdentityAuthService,
      {
        readRoleDefinitionsForTransaction: async () => DEFAULT_ROLE_DEFINITIONS,
      } as unknown as IdentityRoleService,
      {} as IdentityProfileImageService,
    );

    await expect(
      service.updateAccount(
        'Bearer global-operator',
        targetAccountId,
        { roles: [{ code: 'PARTICIPANT' }] },
        true,
      ),
    ).rejects.toThrow(
      'the last global administrator cannot lose the global administrator role',
    );

    expect(
      queries.some((item) =>
        item.sql.includes('UPDATE public.account_role SET valid_to'),
      ),
    ).toBe(false);
    expect(
      queries.some((item) =>
        item.sql.includes('INSERT INTO public.account_role'),
      ),
    ).toBe(false);
    expect(queries.some((item) => item.sql === 'ROLLBACK')).toBe(true);
    expect(queries.some((item) => item.sql === 'COMMIT')).toBe(false);
  });

  it('allows an Identity administrator to retain an existing equal-authority role', async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const account = {
      id: targetAccountId,
      display_name: 'Existing administrator',
      email: 'existing-admin@example.test',
      participation_type: 'OPERATOR',
      status: 'ACTIVE',
      website_url: null,
      biography_markdown: null,
      profile_image_id: null,
      profile_image_media_type: null,
      profile_image_updated_at: null,
      primary_callsign_id: null,
      created_at: '2026-01-01T00:00:00.000000Z',
      updated_at: '2026-01-01T00:00:00.000000Z',
    };
    let currentRoles = [
      {
        role: 'IDENTITY_ADMIN',
        programmeSlug: null,
        jurisdiction: null,
        entityType: null,
      },
    ];
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.includes('FROM public.account a')) {
          return { rows: [account], rowCount: 1 };
        }
        if (sql.includes('SELECT role_code AS role')) {
          return { rows: currentRoles, rowCount: currentRoles.length };
        }
        if (sql.includes('UPDATE public.account_role SET valid_to')) {
          currentRoles = [];
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO public.account_role')) {
          currentRoles = [
            {
              role: String(values[3]),
              programmeSlug: values[2] as string | null,
              jurisdiction: values[6] as string | null,
              entityType: values[4] as string | null,
            },
          ];
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('SELECT to_char(clock_timestamp()')) {
          return {
            rows: [{ timestamp: '2026-01-02T00:00:00.000000Z' }],
            rowCount: 1,
          };
        }
        if (sql.includes('INSERT INTO public.security_event')) {
          return {
            rows: [{ occurred_at: '2026-01-02T00:00:00.000000Z' }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    } as unknown as PoolClient;
    const service = new IdentityAccountService(
      { connect: async () => client } as unknown as Pool,
      {
        currentAccount: async () => ({
          id: 'identity-admin-1',
          scopes: identityAdminScopes,
        }),
      } as unknown as IdentityAuthService,
      {
        readRoleDefinitionsForTransaction: async () => DEFAULT_ROLE_DEFINITIONS,
      } as unknown as IdentityRoleService,
      {} as IdentityProfileImageService,
    );

    const result = await service.updateAccount(
      'Bearer identity-admin',
      targetAccountId,
      { roles: [{ code: 'IDENTITY_ADMIN' }] },
      true,
    );

    expect(result.roles).toMatchObject([
      { accountId: targetAccountId, role: 'IDENTITY_ADMIN' },
    ]);
    expect(
      queries.some((query) => query.sql.includes('UPDATE public.account_role')),
    ).toBe(true);

    const revoked = await service.updateAccount(
      'Bearer identity-admin',
      targetAccountId,
      { roles: [{ code: 'PARTICIPANT' }] },
      true,
    );

    expect(revoked.roles).toMatchObject([
      { accountId: targetAccountId, role: 'PARTICIPANT' },
    ]);
    expect(
      queries.filter((query) =>
        query.sql.includes('UPDATE public.account_role SET valid_to'),
      ),
    ).toHaveLength(2);
    expect(queries.at(-1)?.sql).toBe('COMMIT');
  });
});
