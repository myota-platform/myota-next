import { ForbiddenException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { IdentityAuthService } from './auth.service.js';
import type { IdentityProfileImageService } from './identity-profile-image.service.js';
import type { IdentityRoleService } from './identity-role.service.js';
import { IdentityAccountService } from './identity-account.service.js';

describe('IdentityAccountService account export compatibility', () => {
  const accountId = '11111111-1111-4111-8111-111111111111';

  it('exports ordered account data in one read-only snapshot with exact integers', async () => {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('FROM public.account a')) {
          return {
            rows: [
              {
                id: accountId,
                display_name: 'Operator One',
                email: 'operator@example.test',
                participation_type: 'OPERATOR',
                status: 'ACTIVE',
                website_url: null,
                biography_markdown: null,
                profile_image_id: null,
                profile_image_media_type: null,
                profile_image_updated_at: null,
                primary_callsign_id: 'callsign-2',
                created_at: '2025-01-01T00:00:00.000001Z',
                updated_at: '2025-01-02T00:00:00.000002Z',
              },
            ],
          };
        }
        if (sql.includes('FROM public.callsign c')) {
          return {
            rows: [
              {
                id: 'callsign-1',
                value: 'DL1AAA',
                evidenceIds: ['evidence-1'],
              },
              {
                id: 'callsign-2',
                value: 'DL1BBB',
                evidenceIds: ['evidence-2'],
              },
            ],
          };
        }
        if (sql.includes('FROM public.account_role ar')) {
          return {
            rows: [
              {
                id: 'role-1',
                role: 'PARTICIPANT',
                scopes: ['identity.me'],
                createdAt: '2025-01-01T00:00:00.000003Z',
              },
              {
                id: 'role-2',
                role: 'ACTIVITY_READER',
                scopes: ['activity.read'],
                createdAt: '2025-01-01T00:00:00.000004Z',
              },
            ],
          };
        }
        if (sql.includes('FROM public.callsign_evidence e')) {
          return {
            rows: [
              {
                id: 'evidence-1',
                callsignId: 'callsign-1',
                accountId,
                metadataText: '{"submittedSequence":9007199254740993}',
                submittedAt: '2025-01-03T00:00:00.000005Z',
              },
              {
                id: 'evidence-2',
                callsignId: 'callsign-2',
                accountId,
                metadataText: '{"submittedSequence":9007199254740995}',
                submittedAt: '2025-01-04T00:00:00.000006Z',
              },
            ],
          };
        }
        if (sql.includes('FROM public.security_event')) {
          return {
            rows: [
              {
                id: 'event-1',
                eventType: 'identity.account.created.v1',
                payloadText:
                  '{"accountId":"' +
                  accountId +
                  '","sequence":9007199254740997}',
                occurredAt: '2025-01-05T00:00:00.000007Z',
              },
              {
                id: 'event-2',
                eventType: 'identity.callsign.verified.v1',
                payloadText:
                  '{"accountId":"' +
                  accountId +
                  '","sequence":9007199254740999}',
                occurredAt: '2025-01-06T00:00:00.000008Z',
              },
            ],
          };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    } as unknown as PoolClient;
    const pool = { connect: async () => client } as unknown as Pool;
    const auth = {
      currentAccount: async () => ({ id: accountId, scopes: ['identity.me'] }),
    } as unknown as IdentityAuthService;
    const service = new IdentityAccountService(
      pool,
      auth,
      {} as IdentityRoleService,
      {} as IdentityProfileImageService,
    );

    const exported = await service.exportAccount(
      'Bearer participant',
      accountId,
    );

    expect(queries[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(queries.at(-1)).toBe('COMMIT');
    expect(exported.account).toMatchObject({
      id: accountId,
      displayName: 'Operator One',
      callsigns: [
        { id: 'callsign-1', value: 'DL1AAA' },
        { id: 'callsign-2', value: 'DL1BBB' },
      ],
    });
    expect(exported.roles).toMatchObject([
      { id: 'role-1', role: 'PARTICIPANT' },
      { id: 'role-2', role: 'ACTIVITY_READER' },
    ]);
    expect(exported.callsignEvidence).toMatchObject([
      { id: 'evidence-1', metadata: { submittedSequence: 9007199254740993n } },
      { id: 'evidence-2', metadata: { submittedSequence: 9007199254740995n } },
    ]);
    expect(exported.securityEvents).toMatchObject([
      {
        id: 'event-1',
        payload: { accountId, sequence: 9007199254740997n },
      },
      {
        id: 'event-2',
        payload: { accountId, sequence: 9007199254740999n },
      },
    ]);
    expect(
      queries.find((sql) => sql.includes('FROM public.callsign_evidence e')),
    ).toContain('ORDER BY e.evidence_order');
    expect(
      queries.find((sql) => sql.includes('FROM public.security_event')),
    ).toContain('ORDER BY event_order');
  });

  it('does not open the database when another account is outside the caller scope', async () => {
    const connect = vi.fn();
    const auth = {
      currentAccount: async () => ({
        id: 'another-account',
        scopes: ['identity.me'],
      }),
    } as unknown as IdentityAuthService;
    const service = new IdentityAccountService(
      { connect } as unknown as Pool,
      auth,
      {} as IdentityRoleService,
      {} as IdentityProfileImageService,
    );

    await expect(
      service.exportAccount('Bearer participant', accountId),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(connect).not.toHaveBeenCalled();
  });
});
