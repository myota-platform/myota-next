import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { IdentityAuthService } from './auth.service.js';
import { IdentityCallsignService } from './identity-callsign.service.js';

describe('IdentityCallsignService lifecycle validation order', () => {
  const accountId = '77777777-7777-4777-8777-777777777777';
  const callsignId = '88888888-8888-4888-8888-888888888888';

  function harness(
    options: {
      scopes?: string[];
      accountPrimaryCallsignId?: string | null;
      evidenceIds?: string[];
    } = {},
  ) {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        if (
          sql.includes('FROM public.account a') &&
          sql.includes('FOR UPDATE')
        ) {
          return {
            rows: [
              {
                primary_callsign_id: options.accountPrimaryCallsignId ?? null,
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('FROM public.account WHERE id = $1'))
          return { rows: [{}], rowCount: 1 };
        if (
          sql.includes('FROM public.callsign WHERE id = $1 AND account_id = $2')
        ) {
          return {
            rows: [
              {
                id: callsignId,
                value: 'EA7TEST',
                source: 'self-asserted',
                verification_source: null,
                verified_at: null,
                valid_from: null,
                valid_to: null,
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('FROM public.callsign_evidence')) {
          const rows = (options.evidenceIds ?? []).map((id) => ({ id }));
          return { rows, rowCount: rows.length };
        }
        if (sql.includes('SELECT to_char(clock_timestamp()'))
          return { rows: [{ timestamp: '2026-01-01T00:00:00.000001Z' }] };
        if (sql.includes('UPDATE public.callsign') && sql.includes('RETURNING'))
          return {
            rows: [{ updated_at: '2026-01-01T00:00:00.000002Z' }],
            rowCount: 1,
          };
        return { rows: [], rowCount: 1 };
      },
      release: () => undefined,
    } as unknown as PoolClient;
    const connect = vi.fn(async () => client);
    const auth = {
      currentAccount: async () => ({
        id: accountId,
        scopes: options.scopes ?? ['*'],
      }),
    } as unknown as IdentityAuthService;
    return {
      service: new IdentityCallsignService(
        { connect } as unknown as Pool,
        auth,
      ),
      connect,
      queries,
    };
  }

  it('checks verification evidence before validating optional review fields', async () => {
    const fixture = harness({ scopes: ['callsign.verify'] });

    await expect(
      fixture.service.verifyCallsign('Bearer reviewer', accountId, callsignId, {
        source: 42,
      }),
    ).rejects.toThrow('at least one evidence record is required');

    expect(
      fixture.queries.findIndex((sql) =>
        sql.includes('FROM public.callsign_evidence'),
      ),
    ).toBeGreaterThan(
      fixture.queries.findIndex((sql) =>
        sql.includes('FROM public.callsign WHERE'),
      ),
    );
    expect(
      fixture.queries.some((sql) => sql.includes('UPDATE public.callsign')),
    ).toBe(false);
    expect(fixture.queries.at(-1)).toBe('ROLLBACK');
  });

  it('checks verification scope before connecting to the database', async () => {
    const fixture = harness({ scopes: [] });

    await expect(
      fixture.service.verifyCallsign(
        'Bearer participant',
        accountId,
        callsignId,
        {},
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it('ignores an invalid replacement when retiring a non-primary callsign', async () => {
    const fixture = harness({
      accountPrimaryCallsignId: '99999999-9999-4999-8999-999999999999',
    });

    const retired = await fixture.service.retireCallsign(
      'Bearer owner',
      accountId,
      callsignId,
      { newPrimaryCallsignId: 'not-a-uuid' },
    );

    expect(retired).toMatchObject({ id: callsignId, status: 'RETIRED' });
    expect(
      fixture.queries.some((sql) => sql.includes('lifecycle_status <>')),
    ).toBe(false);
    expect(
      fixture.queries.some((sql) =>
        sql.includes("SET lifecycle_status = 'RETIRED'"),
      ),
    ).toBe(true);
    expect(fixture.queries.at(-1)).toBe('COMMIT');
  });

  it('rejects retiring a primary without an active replacement before reading evidence', async () => {
    const fixture = harness({ accountPrimaryCallsignId: callsignId });

    await expect(
      fixture.service.retireCallsign('Bearer owner', accountId, callsignId, {
        newPrimaryCallsignId: 'not-a-uuid',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(
      fixture.queries.some((sql) =>
        sql.includes('FROM public.callsign_evidence'),
      ),
    ).toBe(false);
    expect(fixture.queries.at(-1)).toBe('ROLLBACK');
  });
});
