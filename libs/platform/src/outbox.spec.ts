import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { writeSecurityEvent } from './outbox.js';

describe('writeSecurityEvent correlation', () => {
  it('persists the supplied request ID on its outbox event', async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        statements.push({ sql, values });
        return sql.includes('INSERT INTO public.security_event')
          ? {
              rows: [{ occurred_at: '2026-10-28T00:00:00.000000Z' }],
              rowCount: 1,
            }
          : { rows: [], rowCount: 1 };
      },
    } as unknown as PoolClient;
    const requestId = '646589b8-1439-4ad9-a397-475a7f3b4eb9';

    await writeSecurityEvent(
      client,
      'identity.login.succeeded.v1',
      { accountId: 'account-1' },
      requestId,
    );

    const outbox = statements.find((statement) =>
      statement.sql.includes('INSERT INTO public.outbox_event'),
    );
    expect(outbox?.values[7]).toBe(requestId);
  });

  it('continues generating a valid correlation ID when none is supplied', async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        statements.push({ sql, values });
        return sql.includes('INSERT INTO public.security_event')
          ? {
              rows: [{ occurred_at: '2026-10-28T00:00:00.000000Z' }],
              rowCount: 1,
            }
          : { rows: [], rowCount: 1 };
      },
    } as unknown as PoolClient;

    await writeSecurityEvent(client, 'identity.role.assigned.v1', {
      accountId: 'account-1',
    });

    const outbox = statements.find((statement) =>
      statement.sql.includes('INSERT INTO public.outbox_event'),
    );
    expect(outbox?.values[7]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});
