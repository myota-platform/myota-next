import { ForbiddenException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { IdentityAuthService } from './auth.service.js';
import type { IdentityProfileImageService } from './identity-profile-image.service.js';
import { IdentityAccountService } from './identity-account.service.js';
import type { IdentityRoleService } from './identity-role.service.js';
import { DEFAULT_ROLE_DEFINITIONS } from './role-catalog.js';

describe('IdentityAccountService role grant authorization', () => {
  const identityAdminScopes = [
    'identity.accounts.create',
    'identity.admin',
    'identity.roles.assign',
    'identity.audit.read',
    'callsign.verify',
  ];

  function harness() {
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
        scopes: identityAdminScopes,
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
});
