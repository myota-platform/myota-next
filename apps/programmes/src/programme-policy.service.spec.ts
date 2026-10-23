import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { ApiProblemFilter } from '../../../libs/platform/src/http-problem.js';
import { signAccessToken } from '../../../libs/platform/src/access-token.js';
import type { ProgrammeMutationRepository } from './programme-mutation.repository.js';
import { ProgrammePolicyController } from './programme-policy.controller.js';
import type { ProgrammePolicyRepository } from './programme-policy.repository.js';
import type { ProgrammeReadRepository } from './programme-read.repository.js';
import type { ProgrammeRepository } from './programme.repository.js';
import { ProgrammePolicyService } from './programme-policy.service.js';

describe('ProgrammePolicyService lifecycle compatibility', () => {
  it('saves, submits, approves, and publishes a rules policy in order', async () => {
    const drafts = new Map<string, Record<string, unknown>>();
    const events: Array<Record<string, unknown>> = [];
    const programme: Record<string, unknown> = {
      slug: 'alpine',
      rules: { minimumQsos: 2 },
      policyVersion: 1,
      awards: [],
      updatedAt: '2025-01-01T00:00:00Z',
    };
    const client = {
      query: async () => ({
        rows: [{ timestamp: '2026-10-21T12:00:00.000000Z' }],
        rowCount: 1,
      }),
    } as unknown as PoolClient;
    const mutations = {
      mutate: async <T>(
        _key: string | undefined,
        operation: (transaction: PoolClient) => Promise<T>,
      ) => operation(client),
      recordEvent: async (
        _transaction: PoolClient,
        eventType: string,
        aggregateType: string,
        aggregateId: string,
        payload: Record<string, unknown>,
      ) => {
        events.push({ eventType, aggregateType, aggregateId, payload });
      },
    } as unknown as ProgrammeMutationRepository;
    const policies = {
      mutate: mutations.mutate.bind(mutations),
      lockRecord: async () => undefined,
      find: async (_transaction: PoolClient, id: string) => {
        const draft = drafts.get(id);
        return draft ? structuredClone(draft) : undefined;
      },
      save: async (
        _transaction: PoolClient,
        draft: Record<string, unknown>,
      ) => {
        drafts.set(String(draft.id), structuredClone(draft));
      },
      recordEvent: async (
        _transaction: PoolClient,
        eventType: string,
        draftId: string,
        payload: Record<string, unknown>,
      ) => {
        events.push({
          eventType,
          aggregateType: 'policy_draft',
          aggregateId: draftId,
          payload,
        });
      },
    } as unknown as ProgrammePolicyRepository;
    const programmeRepository = {
      getInTransaction: async () => programme,
      save: async (
        _transaction: PoolClient,
        value: Record<string, unknown>,
      ) => {
        Object.assign(programme, value);
      },
    } as unknown as ProgrammeRepository;
    const service = new ProgrammePolicyService(
      mutations,
      {} as ProgrammeReadRepository,
      policies,
      programmeRepository,
    );
    const authorization = `Bearer ${signAccessToken('admin-1', ['programme.admin'])}`;

    const saved = await service.save(authorization, 'alpine', {
      type: 'RULES',
      name: '2026 rules',
      schema: { rules: { minimumQsos: 4, validityDays: 2 } },
      effectiveFrom: '2026-04-01T08:00:00+02:30',
    });
    const draftId = String(saved.draft.id);
    expect(saved.statusCode).toBe(201);
    expect(saved.draft.effectiveFrom).toBe('2026-04-01T05:30:00Z');

    const submitted = await service.submit(authorization, 'alpine', draftId);
    expect(submitted.status).toBe('UNDER_REVIEW');
    expect(submitted.reviewHistory).toMatchObject([{ action: 'SUBMITTED' }]);

    const approved = await service.review(authorization, 'alpine', draftId, {
      decision: 'APPROVED',
      reviewerId: 'reviewer-1',
      note: 'Approved for the next season',
    });
    expect(approved.status).toBe('APPROVED');
    expect(approved.reviewHistory.at(-1)).toMatchObject({
      action: 'APPROVED',
      reviewerId: 'reviewer-1',
      note: 'Approved for the next season',
    });

    const published = await service.publish(authorization, 'alpine', draftId, {
      effectiveFrom: '2026-06-01',
      publisherId: 'publisher-1',
    });
    expect(published.draft.status).toBe('PUBLISHED');
    expect(published.draft.reviewHistory.at(-1)).toMatchObject({
      action: 'PUBLISHED',
      publisherId: 'publisher-1',
      effectiveFrom: '2026-06-01T00:00:00Z',
    });
    expect(programme).toMatchObject({
      rules: { minimumQsos: 4, validityDays: 2 },
      policyVersion: 2,
    });
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.eventType)).toEqual([
      'programme.policy-draft.saved.v1',
      'programme.policy-draft.published.v1',
    ]);
    expect(events[1]).toMatchObject({
      eventType: 'programme.policy-draft.published.v1',
      aggregateType: 'policy_draft',
      aggregateId: draftId,
      payload: { status: 'PUBLISHED' },
    });
  });
});

describe('ProgrammePolicyController validation precedence', () => {
  async function createApp() {
    const service = new ProgrammePolicyService(
      {} as ProgrammeMutationRepository,
      {} as ProgrammeReadRepository,
      { get: async () => undefined } as unknown as ProgrammePolicyRepository,
      {} as ProgrammeRepository,
    );
    const module = await Test.createTestingModule({
      controllers: [ProgrammePolicyController],
      providers: [{ provide: ProgrammePolicyService, useValue: service }],
    }).compile();
    const app = module.createNestApplication();
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    app.useGlobalFilters(new ApiProblemFilter());
    await app.init();
    return app;
  }

  it('authorizes before validating a policy draft request body', async () => {
    const app = await createApp();
    try {
      const response = await request(app.getHttpServer())
        .post('/v1/programmes/alpine/policy-drafts')
        .send({ type: 'INVALID' })
        .expect(403);
      expect(response.body.detail).toBe('Bearer authentication is required');
    } finally {
      await app.close();
    }
  });

  it('authorizes review transitions before checking reviewer fields', async () => {
    const app = await createApp();
    try {
      const response = await request(app.getHttpServer())
        .patch('/v1/programmes/alpine/policy-drafts/draft-1')
        .send({ status: 'APPROVED' })
        .expect(403);
      expect(response.body.detail).toBe('Bearer authentication is required');
    } finally {
      await app.close();
    }
  });

  it('resolves an unknown-status patch draft before authorizing its save', async () => {
    const app = await createApp();
    try {
      const response = await request(app.getHttpServer())
        .patch('/v1/programmes/alpine/policy-drafts/missing-draft')
        .send({ status: 'UNSUPPORTED' })
        .expect(400);
      expect(response.body.detail).toBe('policy draft not found');
    } finally {
      await app.close();
    }
  });
});
