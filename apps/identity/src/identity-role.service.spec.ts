import { ForbiddenException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { IdentityAuthService } from './auth.service.js';
import { IdentityRoleService } from './identity-role.service.js';
import { ADMIN_PERMISSION_CATALOG } from './role-catalog.js';

describe('IdentityRoleService Python compatibility', () => {
  it('sorts custom role codes by code point like Python string ordering', async () => {
    const timestamp = new Date('2026-01-01T00:00:00Z');
    const codes = ['A_', 'AB', 'A0', 'AA'];
    const client = {
      query: async () => ({
        rows: codes.map((code) => ({
          code,
          name: code,
          description: '',
          scopes: [],
          system: false,
          created_at: timestamp,
          updated_at: timestamp,
        })),
        rowCount: codes.length,
      }),
    } as unknown as PoolClient;
    const service = new IdentityRoleService(null, {} as IdentityAuthService);

    const roles = await service.readRoleDefinitionsForTransaction(client);

    expect(
      roles.map((role) => role.code).filter((code) => codes.includes(code)),
    ).toEqual(['A0', 'AA', 'AB', 'A_']);
  });

  it('removes the retired operations permission from legacy role scopes', async () => {
    const timestamp = new Date('2026-01-01T00:00:00Z');
    const client = {
      query: async () => ({
        rows: [
          {
            code: 'CUSTOM_READER',
            name: 'Custom reader',
            description: '',
            scopes: ['operations.read', 'observability.view'],
            system: false,
            created_at: timestamp,
            updated_at: timestamp,
          },
        ],
        rowCount: 1,
      }),
    } as unknown as PoolClient;
    const service = new IdentityRoleService(null, {} as IdentityAuthService);

    const definitions = await service.readRoleDefinitionsForTransaction(client);
    const customRole = definitions.find(
      (definition) => definition.code === 'CUSTOM_READER',
    );

    expect(customRole?.scopes).toEqual(['observability.view']);
    expect(
      ADMIN_PERMISSION_CATALOG.some(
        (permission) => permission.code === 'operations.read',
      ),
    ).toBe(false);
  });

  it('lets account creators read role choices without account-admin access', async () => {
    const timestamp = '2026-01-01T00:00:00.000000Z';
    const client = {
      query: async (sql: string) =>
        sql.includes('clock_timestamp')
          ? { rows: [{ timestamp }], rowCount: 1 }
          : { rows: [], rowCount: 0 },
      release: () => undefined,
    } as unknown as PoolClient;
    const connect = vi.fn(async () => client);
    const currentAccount = vi.fn(async () => ({
      id: 'account-creator',
      scopes: ['identity.accounts.create'],
    }));
    const service = new IdentityRoleService(
      { connect } as unknown as Pool,
      { currentAccount } as unknown as IdentityAuthService,
    );

    const catalogue = await service.listAdminRoles('Bearer creator');
    expect(currentAccount).toHaveBeenCalledWith('Bearer creator');
    expect(connect).toHaveBeenCalledOnce();
    expect(catalogue.items).toContainEqual(
      expect.objectContaining({ code: 'PARTICIPANT' }),
    );
    expect(
      ADMIN_PERMISSION_CATALOG.map((permission) => permission.code),
    ).toContain('identity.accounts.create');
  });

  it('denies role-catalogue reads to callers without an accepted scope', async () => {
    const connect = vi.fn();
    const currentAccount = vi.fn(async () => ({
      id: 'participant',
      scopes: ['identity.me'],
    }));
    const service = new IdentityRoleService(
      { connect } as unknown as Pool,
      { currentAccount } as unknown as IdentityAuthService,
    );

    await expect(
      service.listAdminRoles('Bearer participant'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(currentAccount).toHaveBeenCalledWith('Bearer participant');
    expect(connect).not.toHaveBeenCalled();
  });
});
