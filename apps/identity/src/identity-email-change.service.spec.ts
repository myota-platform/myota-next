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
        if (
          sql.includes('SELECT change_id') &&
          sql.includes('FROM public.identity_email_change_token')
        ) {
          return {
            rows: tokenSides.has(String(values[0]))
              ? [{ change_id: changeId }]
              : [],
            rowCount: tokenSides.has(String(values[0])) ? 1 : 0,
          };
        }
        if (
          sql.includes('SELECT id') &&
          sql.includes('FROM public.identity_email_change') &&
          sql.includes('FOR UPDATE')
        )
          return { rows: [{ id: changeId }], rowCount: 1 };
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

  it('serializes simultaneous confirmations and completes the pending change once', async () => {
    const tokens = new Map<
      string,
      { addressKind: 'old' | 'new'; used: boolean }
    >();
    const statements: string[] = [];
    let oldVerifiedAt: Date | null = null;
    let newVerifiedAt: Date | null = null;
    let canceled = false;
    let completed = false;
    let accountUpdates = 0;
    let changeLocked = false;
    const lockWaiters: Array<() => void> = [];

    const acquireChangeLock = async () => {
      if (!changeLocked) {
        changeLocked = true;
        return;
      }
      await new Promise<void>((resolve) => lockWaiters.push(resolve));
    };
    const releaseChangeLock = () => {
      const next = lockWaiters.shift();
      if (next) next();
      else changeLocked = false;
    };

    for (const [token, addressKind] of [
      ['A'.repeat(43), 'old'],
      ['B'.repeat(43), 'new'],
    ] as const) {
      tokens.set(createHash('sha256').update(token).digest('hex'), {
        addressKind,
        used: false,
      });
    }

    const pool = {
      connect: async () => {
        let ownsChangeLock = false;
        const client = {
          query: async (sql: string, values: unknown[] = []) => {
            statements.push(sql);
            if (sql.includes('SELECT change_id')) {
              const row = tokens.get(String(values[0]));
              return {
                rows: row ? [{ change_id: changeId }] : [],
                rowCount: row ? 1 : 0,
              };
            }
            if (sql.includes('SELECT id') && sql.includes('FOR UPDATE')) {
              await acquireChangeLock();
              ownsChangeLock = true;
              const active = !canceled && !completed;
              return {
                rows: active ? [{ id: changeId }] : [],
                rowCount: active ? 1 : 0,
              };
            }
            if (sql.includes('SELECT t.token_hash AS token_id')) {
              const row = tokens.get(String(values[0]));
              const active = row && !row.used && values[1] === changeId;
              return {
                rows: active
                  ? [
                      {
                        token_id: values[0],
                        change_id: changeId,
                        address_kind: row.addressKind,
                        account_id: accountId,
                        old_verified_at: oldVerifiedAt,
                        new_verified_at: newVerifiedAt,
                        display_name: 'Casey Participant',
                        old_email_key: 'old@example.test',
                        new_email: 'new@example.test',
                        new_email_key: 'new@example.test',
                      },
                    ]
                  : [],
                rowCount: active ? 1 : 0,
              };
            }
            if (sql.includes('UPDATE public.identity_email_change_token')) {
              const row = tokens.get(String(values[0]));
              if (row) row.used = true;
              return { rows: [], rowCount: row ? 1 : 0 };
            }
            if (sql.includes('SET old_verified_at =')) {
              oldVerifiedAt ??= new Date();
              return { rows: [], rowCount: 1 };
            }
            if (sql.includes('SET new_verified_at =')) {
              newVerifiedAt ??= new Date();
              return { rows: [], rowCount: 1 };
            }
            if (sql.includes('UPDATE public.account')) {
              accountUpdates += 1;
              return { rows: [], rowCount: 1 };
            }
            if (sql.includes('SET completed_at =')) {
              completed = true;
              return { rows: [], rowCount: 1 };
            }
            if (sql.includes('INSERT INTO public.security_event'))
              return {
                rows: [{ occurred_at: new Date().toISOString() }],
                rowCount: 1,
              };
            if (sql.includes('INSERT INTO public.outbox_event'))
              return { rows: [], rowCount: 1 };
            return { rows: [], rowCount: 0 };
          },
          release: () => {
            if (ownsChangeLock) releaseChangeLock();
          },
        };
        return client as unknown as PoolClient;
      },
    } as unknown as Pool;
    const service = new IdentityEmailChangeService(pool, {} as never);

    const outcomes = await Promise.all([
      service.confirm({ token: 'A'.repeat(43) }),
      service.confirm({ token: 'B'.repeat(43) }),
    ]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
      'email_changed',
      'one_address_verified',
    ]);
    expect(accountUpdates).toBe(1);
    expect([...tokens.values()].every((token) => token.used)).toBe(true);
    const referenceRead = statements.findIndex((sql) =>
      sql.includes('SELECT change_id'),
    );
    const sharedLock = statements.findIndex(
      (sql) => sql.includes('SELECT id') && sql.includes('FOR UPDATE'),
    );
    const tokenLock = statements.findIndex((sql) =>
      sql.includes('SELECT t.token_hash AS token_id'),
    );
    expect(referenceRead).toBeLessThan(sharedLock);
    expect(sharedLock).toBeLessThan(tokenLock);
  });
});
