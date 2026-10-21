import type { PoolClient } from 'pg';
import type { IdentityAuthService } from './auth.service.js';
import { IdentityRoleService } from './identity-role.service.js';

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
});
