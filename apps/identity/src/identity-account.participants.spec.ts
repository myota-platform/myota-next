import { ForbiddenException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { vi } from 'vitest';
import { IdentityAccountService } from './identity-account.service.js';

const accountId = '566b8475-bda2-4a2d-8ab8-d7a9a93c0041';

function fixture(scopes: string[], actorId = 'support-1') {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const auth = {
    currentAccount: vi.fn().mockResolvedValue({ id: actorId, scopes }),
  };
  const client = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      statements.push({ sql, values });
      if (sql.includes('count(*)::text AS total'))
        return { rows: [{ total: '1' }], rowCount: 1 };
      if (sql.includes('SELECT a.id, a.display_name, a.email::text AS email'))
        return {
          rows: [
            {
              id: accountId,
              display_name: 'Casey Operator',
              email: 'casey@example.test',
              status: 'ACTIVE',
              email_verified: true,
              created_at: '2026-10-01T00:00:00.000000Z',
              updated_at: '2026-10-01T00:00:00.000000Z',
            },
          ],
          rowCount: 1,
        };
      if (sql.includes('UPDATE public.account a'))
        return {
          rows: [
            {
              id: accountId,
              display_name: 'Casey Operator',
              email: 'casey@example.test',
              status: 'SUSPENDED',
              email_verified: true,
              created_at: '2026-10-01T00:00:00.000000Z',
              updated_at: '2026-10-26T00:00:00.000000Z',
            },
          ],
          rowCount: 1,
        };
      if (sql.includes('INSERT INTO public.security_event'))
        return {
          rows: [{ occurred_at: '2026-10-26T00:00:00.000000Z' }],
          rowCount: 1,
        };
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(),
  } as unknown as PoolClient;
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool;
  const service = new IdentityAccountService(
    pool,
    auth as never,
    {} as never,
    {} as never,
  );
  return { service, auth, client, statements };
}

describe('Identity participant account administration', () => {
  it('does not let a Participant Administrator assign roles to their own account', async () => {
    const harness = fixture(['identity.participants.manage'], accountId);
    await expect(
      harness.service.updateAccount(
        'Bearer token',
        accountId,
        {
          roles: [{ code: 'PARTICIPANT' }, { code: 'PARTICIPANT_ADMIN' }],
        },
        true,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(harness.statements).toEqual([]);
  });

  it('requires the participant-specific scope instead of broad Identity scopes', async () => {
    const denied = fixture(['identity.admin']);
    await expect(
      denied.service.listParticipants('Bearer token', {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(denied.statements).toEqual([]);

    const allowed = fixture(['identity.participants.manage']);
    await expect(
      allowed.service.listParticipants('Bearer token', {}),
    ).resolves.toMatchObject({ total: 1, items: [{ emailVerified: true }] });
    expect(
      allowed.statements.some(
        ({ sql }) =>
          sql.includes("role_code = 'PARTICIPANT'") &&
          sql.includes('elevated_role.role_code <>'),
      ),
    ).toBe(true);
  });

  it('rejects role and email changes, and revokes sessions when suspending', async () => {
    const harness = fixture(['identity.participants.manage']);
    await expect(
      harness.service.updateParticipant('Bearer token', accountId, {
        roles: [{ role: 'GLOBAL_OPERATOR' }],
      }),
    ).rejects.toThrow('unsupported participant update fields');
    expect(harness.statements).toEqual([]);

    await expect(
      harness.service.updateParticipant('Bearer token', accountId, {
        status: 'SUSPENDED',
      }),
    ).resolves.toMatchObject({ status: 'SUSPENDED' });
    expect(
      harness.statements.some(
        ({ sql }) =>
          sql.includes('UPDATE public.auth_session') &&
          sql.includes('SET revoked_at = coalesce'),
      ),
    ).toBe(true);
    expect(
      harness.statements.some(
        ({ sql, values }) =>
          sql.includes('INSERT INTO public.security_event') &&
          values[2] === 'identity.account.admin-updated.v1',
      ),
    ).toBe(true);
  });
});
