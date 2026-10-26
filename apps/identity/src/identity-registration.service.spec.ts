import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { afterEach, vi } from 'vitest';
import { IdentityRegistrationService } from './identity-registration.service.js';

const accountId = '566b8475-bda2-4a2d-8ab8-d7a9a93c0041';

function registrationHarness(existingAccount = false) {
  const tokens = new Map<
    string,
    { account_id: string; used_at: Date | null; expires_at: Date }
  >();
  const events: Array<{
    eventType: string;
    aggregateId: string;
    payload: Record<string, unknown>;
  }> = [];
  const account = existingAccount
    ? {
        id: accountId,
        display_name: 'Casey Operator',
        email_verified: false,
      }
    : null;
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.includes('identity_registration_rate_limit'))
      return { rows: [{ request_count: 1 }], rowCount: 1 };
    if (sql.includes('FROM public.account') && sql.includes('FOR UPDATE'))
      return { rows: account ? [account] : [], rowCount: account ? 1 : 0 };
    if (sql.includes('INSERT INTO public.account\n'))
      return {
        rows: [
          {
            id: accountId,
            display_name: 'Casey Operator',
            created_at: '2026-10-26T09:00:00.000000Z',
            updated_at: '2026-10-26T09:00:00.000000Z',
          },
        ],
        rowCount: 1,
      };
    if (sql.includes('INSERT INTO public.identity_email_verification_token')) {
      const tokenHash = String(values[0]);
      tokens.set(tokenHash, {
        account_id: accountId,
        used_at: null,
        expires_at: new Date(Date.now() + 86_400_000),
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('SELECT account_id, used_at, expires_at')) {
      const saved = tokens.get(String(values[0]));
      return { rows: saved ? [saved] : [], rowCount: saved ? 1 : 0 };
    }
    if (sql.includes('SET used_at = clock_timestamp()')) {
      const saved = tokens.get(String(values[0]));
      if (saved) saved.used_at = new Date();
      return { rows: [], rowCount: saved ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO public.outbox_event')) {
      events.push({
        eventType: String(values[1]),
        aggregateId: String(values[4]),
        payload: JSON.parse(String(values[5])) as Record<string, unknown>,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO public.security_event'))
      return {
        rows: [{ occurred_at: '2026-10-26T09:01:00.000000Z' }],
        rowCount: 1,
      };
    return { rows: [], rowCount: 1 };
  });
  const client = {
    query,
    release: vi.fn(),
  } as unknown as PoolClient;
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool;
  return {
    service: new IdentityRegistrationService(pool),
    query,
    events,
    tokens,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('IdentityRegistrationService', () => {
  it('creates a participant-only pending account and queues a verification email', async () => {
    vi.stubEnv(
      'MYOTA_PARTICIPANT_PUBLIC_URL',
      'https://participant.example.test',
    );
    const harness = registrationHarness();
    const result = await harness.service.register(
      {
        displayName: 'Casey Operator',
        email: ' Casey@Example.Test ',
        password: 'long-enough-test-password',
        participationType: 'OPERATOR',
      },
      '192.0.2.10',
    );

    expect(result.message).toBe(
      'If registration can proceed, a verification email will be sent.',
    );
    expect(
      harness.query.mock.calls.some(
        ([sql]) =>
          String(sql).includes('INSERT INTO public.account_role') &&
          String(sql).includes("'PARTICIPANT'"),
      ),
    ).toBe(true);
    expect(
      harness.query.mock.calls.some(([sql]) =>
        String(sql).includes('PARTICIPANT_ADMIN'),
      ),
    ).toBe(false);
    const created = harness.events.find(
      (event) => event.eventType === 'identity.account.created.v1',
    );
    expect(created?.payload.account).toMatchObject({
      id: accountId,
      email: 'casey@example.test',
      status: 'PENDING_SETUP',
    });
    const delivery = harness.events.find(
      (event) => event.eventType === 'email.send.v1',
    );
    expect(delivery?.payload).toMatchObject({
      requestId: delivery?.aggregateId,
      recipientAccountId: accountId,
      templateId: 'participant-email-verification.v1',
    });
    const templateData = delivery?.payload.templateData as {
      verificationUrl: string;
    };
    const token = new URL(templateData.verificationUrl).searchParams.get(
      'token',
    );
    expect(token).toBeTruthy();
    expect(
      harness.tokens.has(createHash('sha256').update(token!).digest('hex')),
    ).toBe(true);
  });

  it('verifies a token once, activates the account, and rejects replay', async () => {
    vi.stubEnv(
      'MYOTA_PARTICIPANT_PUBLIC_URL',
      'https://participant.example.test',
    );
    const harness = registrationHarness();
    await harness.service.register(
      {
        displayName: 'Casey Operator',
        email: 'casey@example.test',
        password: 'long-enough-test-password',
        participationType: 'OPERATOR',
      },
      '192.0.2.10',
    );
    const delivery = harness.events.find(
      (event) => event.eventType === 'email.send.v1',
    )!;
    const verificationUrl = (
      delivery.payload.templateData as { verificationUrl: string }
    ).verificationUrl;
    const token = new URL(verificationUrl).searchParams.get('token')!;

    await expect(harness.service.verify({ token })).resolves.toEqual({
      message: 'Email verified. You can now sign in.',
    });
    expect(
      harness.query.mock.calls.some(([sql]) =>
        String(sql).includes("email_verified = true, status = 'ACTIVE'"),
      ),
    ).toBe(true);
    await expect(harness.service.verify({ token })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('uses the same generic response for an existing unverified address', async () => {
    vi.stubEnv(
      'MYOTA_PARTICIPANT_PUBLIC_URL',
      'https://participant.example.test',
    );
    const harness = registrationHarness(true);
    const result = await harness.service.register(
      {
        displayName: 'Different Name',
        email: 'casey@example.test',
        password: 'another-long-test-password',
        participationType: 'SWL',
      },
      '192.0.2.10',
    );
    expect(result.message).toBe(
      'If registration can proceed, a verification email will be sent.',
    );
    expect(
      harness.events.filter((event) => event.eventType === 'email.send.v1'),
    ).toHaveLength(1);
    expect(
      harness.query.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO public.account\n'),
      ),
    ).toBe(false);
  });
});
