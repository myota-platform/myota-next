import { BadRequestException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { IdentityAuthService } from './auth.service.js';
import { IdentityCallsignService } from './identity-callsign.service.js';

describe('IdentityCallsignService Python compatibility', () => {
  const accountId = '77777777-7777-4777-8777-777777777777';

  function harness(
    participationType = 'OPERATOR',
    existingCallsigns: Array<{
      id: string;
      account_id: string;
      value: string;
      lifecycle_status: string;
    }> = [],
  ) {
    const accountRecord = {
      id: accountId,
      display_name: 'Test Operator',
      email: 'operator@example.test',
      participation_type: participationType,
      status: 'ACTIVE',
      website_url: null,
      biography_markdown: null,
      profile_image_id: null,
      profile_image_media_type: null,
      profile_image_updated_at: null,
      primary_callsign_id: null as string | null,
      created_at: new Date('2025-01-01T00:00:00Z'),
      updated_at: new Date('2025-01-01T00:00:00Z'),
    };
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const callsigns = [...existingCallsigns];
    const events: Array<Record<string, unknown>> = [];
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (
          sql.includes('FROM public.account a') &&
          sql.includes('FOR UPDATE')
        ) {
          return {
            rows: [
              {
                participation_type: participationType,
                primary_callsign_id: accountRecord.primary_callsign_id,
              },
            ],
            rowCount: 1,
          };
        }
        if (
          sql.includes('FROM public.callsign') &&
          sql.includes('value = $2')
        ) {
          const duplicate = callsigns.some(
            (item) =>
              item.account_id === values[0] &&
              item.value === values[1] &&
              item.lifecycle_status !== 'RETIRED',
          );
          return { rows: [], rowCount: duplicate ? 1 : 0 };
        }
        if (sql.includes('INSERT INTO public.callsign')) {
          callsigns.push({
            id: String(values[0]),
            account_id: String(values[1]),
            value: String(values[2]),
            lifecycle_status: String(values[3]),
          });
          return {
            rows: [
              {
                created_at: new Date('2026-01-01T00:00:00Z'),
                updated_at: new Date('2026-01-01T00:00:00Z'),
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('INSERT INTO public.account_primary_callsign')) {
          accountRecord.primary_callsign_id = String(values[1]);
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('UPDATE public.account SET updated_at')) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO public.outbox_event')) {
          events.push({
            eventType: values[1],
            aggregateType: values[3],
            aggregateId: values[4],
            payload: JSON.parse(String(values[5])),
          });
          return { rows: [], rowCount: 1 };
        }
        if (
          sql.includes('FROM public.account a') &&
          sql.includes('WHERE a.id = $1')
        ) {
          return { rows: [{ ...accountRecord }], rowCount: 1 };
        }
        if (sql.includes('FROM public.callsign c')) {
          return {
            rows: callsigns
              .filter((item) => item.account_id === values[0])
              .map((item) => ({
                id: item.id,
                value: item.value,
                status: item.lifecycle_status,
                source: 'self-asserted',
                verificationSource: null,
                verifiedAt: null,
                validFrom: null,
                validTo: null,
                createdAt: new Date('2026-01-01T00:00:00Z'),
                updatedAt: new Date('2026-01-01T00:00:00Z'),
                evidenceIds: [],
              })),
            rowCount: callsigns.length,
          };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    } as unknown as PoolClient;
    const pool = { connect: async () => client } as unknown as Pool;
    const auth = {
      currentAccount: async () => ({ id: accountId, scopes: [] }),
    } as unknown as IdentityAuthService;
    return {
      service: new IdentityCallsignService(pool, auth),
      queries,
      callsigns,
      events,
    };
  }

  it('trims Python whitespace, uppercases, defaults fields, and selects the first operator callsign', async () => {
    const fixture = harness();
    const result = await fixture.service.addCallsign('Bearer test', accountId, {
      callsign: '\u001c ea7test \u00a0',
    });

    expect(result.callsign.value).toBe('EA7TEST');
    expect(result.callsign.status).toBe('UNVERIFIED');
    expect(result.callsign.source).toBe('self-asserted');
    expect(result.callsign.verificationSource).toBeNull();
    expect(result.account.primaryCallsignId).toBe(result.callsign.id);
    expect(
      fixture.queries.find((item) =>
        item.sql.includes('INSERT INTO public.callsign'),
      )?.values,
    ).toEqual([
      result.callsign.id,
      accountId,
      'EA7TEST',
      'UNVERIFIED',
      'self-asserted',
      null,
      null,
      null,
      null,
    ]);
    expect(fixture.events).toHaveLength(1);
    expect(fixture.events[0].eventType).toBe('identity.callsign.added.v1');
  });

  it('allows a retired value to be added again and does not auto-select an SWL callsign', async () => {
    const fixture = harness('SWL', [
      {
        id: '88888888-8888-4888-8888-888888888888',
        account_id: accountId,
        value: 'EA7TEST',
        lifecycle_status: 'RETIRED',
      },
    ]);
    const result = await fixture.service.addCallsign('Bearer test', accountId, {
      callsign: 'ea7test',
    });

    expect(result.callsign.value).toBe('EA7TEST');
    expect(result.account.primaryCallsignId).toBeNull();
    expect(fixture.callsigns).toHaveLength(2);
  });

  it('rejects a duplicate active value and rolls back the transaction', async () => {
    const fixture = harness('OPERATOR', [
      {
        id: '99999999-9999-4999-8999-999999999999',
        account_id: accountId,
        value: 'EA7TEST',
        lifecycle_status: 'UNVERIFIED',
      },
    ]);

    await expect(
      fixture.service.addCallsign('Bearer test', accountId, {
        callsign: ' ea7test ',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fixture.queries.some((item) => item.sql === 'ROLLBACK')).toBe(true);
    expect(fixture.events).toHaveLength(0);
  });
});
