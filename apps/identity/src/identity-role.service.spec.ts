import type { PoolClient } from 'pg';
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
});
