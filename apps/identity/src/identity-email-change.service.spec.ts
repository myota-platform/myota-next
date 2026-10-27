import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterEach, vi } from 'vitest';
import { IdentityEmailChangeService } from './identity-email-change.service.js';

afterEach(() => vi.unstubAllEnvs());

describe('IdentityEmailChangeService', () => {
  const accountId = '55555555-5555-4555-8555-555555555555';
  const changeId = '66666666-6666-4666-8666-666666666666';
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

  it('changes the account email only after both separate links are confirmed', async () => {
    const tokenSides = new Map<string, 'old' | 'new'>();
    const queries: string[] = [];
    const queryValues: unknown[][] = [];
    let oldVerifiedAt: Date | null = null;
    let newVerifiedAt: Date | null = null;
    let emailUpdated = false;
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        queries.push(sql);
        queryValues.push(values);
        if (sql.includes('SELECT c.account_id, a.display_name')) {
          return {
            rows: [
              {
                account_id: accountId,
                display_name: 'Casey Participant',
                old_email: 'old@example.test',
                new_email: 'new@example.test',
                expires_at: expiresAt,
                canceled_at: null,
                completed_at: null,
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('INSERT INTO public.identity_email_change_token')) {
          tokenSides.set(String(values[0]), String(values[2]) as 'old' | 'new');
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('SELECT t.token_hash AS token_id')) {
          const side = tokenSides.get(String(values[0]));
          return side
            ? {
                rows: [
                  {
                    token_id: values[0],
                    change_id: changeId,
                    address_kind: side,
                    account_id: accountId,
                    old_verified_at: oldVerifiedAt,
                    new_verified_at: newVerifiedAt,
                    display_name: 'Casey Participant',
                    old_email_key: 'old@example.test',
                    new_email: 'new@example.test',
                    new_email_key: 'new@example.test',
                  },
                ],
                rowCount: 1,
              }
            : { rows: [], rowCount: 0 };
        }
        if (sql.includes('UPDATE public.identity_email_change_token')) {
          tokenSides.delete(String(values[0]));
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('SET old_verified_at =')) oldVerifiedAt = new Date();
        if (sql.includes('SET new_verified_at =')) newVerifiedAt = new Date();
        if (sql.includes('UPDATE public.account')) {
          emailUpdated = true;
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO public.security_event'))
          return {
            rows: [{ occurred_at: new Date().toISOString() }],
            rowCount: 1,
          };
        return { rows: [], rowCount: 1 };
      },
      release: () => undefined,
    } as unknown as PoolClient;
    const pool = { connect: async () => client } as unknown as Pool;
    const service = new IdentityEmailChangeService(pool, {} as never);
    vi.stubEnv(
      'MYOTA_PARTICIPANT_PUBLIC_URL',
      'https://participant.example.test/',
    );

    const oldDelivery = await service.resolveDelivery(
      accountId,
      'participant-email-change-old.v1',
      changeId,
    );
    const newDelivery = await service.resolveDelivery(
      accountId,
      'participant-email-change-new.v1',
      changeId,
    );
    const oldToken = new URL(oldDelivery.templateData.confirmationUrl).hash
      .slice(1)
      .replace('emailChangeToken=', '');
    const newToken = new URL(newDelivery.templateData.confirmationUrl).hash
      .slice(1)
      .replace('emailChangeToken=', '');

    expect(oldDelivery.deliverableAddress).toBe('old@example.test');
    expect(newDelivery.deliverableAddress).toBe('new@example.test');
    expect(oldToken).not.toBe(newToken);
    expect(
      tokenSides.has(createHash('sha256').update(oldToken).digest('hex')),
    ).toBe(true);
    expect(JSON.stringify(queryValues)).not.toContain(oldToken);
    expect(JSON.stringify(queryValues)).not.toContain(newToken);
    expect(await service.confirm({ token: oldToken })).toEqual({
      status: 'one_address_verified',
    });
    expect(emailUpdated).toBe(false);
    expect(await service.confirm({ token: newToken })).toEqual({
      status: 'email_changed',
    });
    expect(emailUpdated).toBe(true);
    expect(
      queries.filter((sql) => sql.includes('UPDATE public.account')),
    ).toHaveLength(1);
  });
});
