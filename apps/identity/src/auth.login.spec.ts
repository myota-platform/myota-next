import { ForbiddenException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { hashPassword, IdentityAuthService } from './auth.service.js';

describe('IdentityAuthService.login rate limits', () => {
  const password = 'StandardOperatorPassword!2026';
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await hashPassword(password);
  });

  function harness(globalOperator: boolean) {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    let rateCount = 0;
    let globalOperatorChecks = 0;
    const account = {
      id: 'account-1',
      display_name: 'Standard Operator',
      email: 'standard@example.test',
      participation_type: 'OPERATOR',
      status: 'ACTIVE',
      created_at: new Date('2025-01-01T00:00:00Z'),
      updated_at: new Date('2025-01-01T00:00:00Z'),
      primary_callsign_id: null,
      password_hash: passwordHash,
      failed_attempts: 0,
      locked_until: null,
    };
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        statements.push({ sql, values });
        if (sql.includes('FROM public.account a'))
          return { rows: [account], rowCount: 1 };
        if (sql.includes('FROM public.account_role')) {
          globalOperatorChecks++;
          return { rows: [], rowCount: globalOperator ? 1 : 0 };
        }
        if (sql.includes('INSERT INTO public.identity_login_rate_limit')) {
          rateCount++;
          return { rows: [{ request_count: rateCount }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    } as unknown as PoolClient;
    const pool = {
      connect: async () => client,
    } as unknown as Pool;
    const service = new IdentityAuthService(pool);
    const internal = service as unknown as {
      writeAudit: (...args: unknown[]) => Promise<void>;
      createSession: (...args: unknown[]) => Promise<Record<string, unknown>>;
    };
    internal.writeAudit = async () => undefined;
    internal.createSession = async () => ({
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
    });

    return {
      service,
      statements,
      get rateCount() {
        return rateCount;
      },
      get globalOperatorChecks() {
        return globalOperatorChecks;
      },
    };
  }

  it('applies the general attempt limit to standard accounts', async () => {
    const fixture = harness(false);
    for (let attempt = 0; attempt < 8; attempt++) {
      await fixture.service.login(
        { email: '  STANDARD@example.test ', password },
        { userAgent: null, remoteAddr: '192.0.2.10' },
      );
    }

    await expect(
      fixture.service.login(
        { email: 'standard@example.test', password },
        { userAgent: null, remoteAddr: '192.0.2.10' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(fixture.rateCount).toBe(9);
    expect(fixture.globalOperatorChecks).toBe(9);
    const rateKeys = fixture.statements
      .filter((entry) => entry.sql.includes('identity_login_rate_limit'))
      .map((entry) => entry.values[0]);
    expect(new Set(rateKeys).size).toBe(1);
    expect(rateKeys[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('lets global operators bypass the general attempt limit', async () => {
    const fixture = harness(true);
    for (let attempt = 0; attempt < 12; attempt++) {
      await fixture.service.login(
        { email: 'standard@example.test', password },
        { userAgent: null, remoteAddr: '192.0.2.10' },
      );
    }

    expect(fixture.rateCount).toBe(0);
    expect(fixture.globalOperatorChecks).toBe(12);
  });
});
