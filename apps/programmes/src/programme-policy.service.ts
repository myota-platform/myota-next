import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { verifyAccessToken } from '@app/platform/access-token.js';
import { pythonKeyErrorDetail } from '@app/platform/python-strings.js';
import {
  nextPageIfMore,
  pageOffset,
  parsePageInteger,
} from '@app/platform/pagination.js';
import {
  getUtcTimestamp,
  ProgrammeMutationRepository,
} from './programme-mutation.repository.js';
import { ProgrammeReadRepository } from './programme-read.repository.js';
import { ProgrammeRepository } from './programme.repository.js';
import {
  ProgrammePolicyRepository,
  type ProgrammePolicyDraft,
} from './programme-policy.repository.js';
import {
  PublishProgrammePolicyDraftDto,
  ReviewProgrammePolicyDraftDto,
  SaveProgrammePolicyDraftDto,
} from './programmes.dto.js';
import { nextPolicyVersion } from './programme.types.js';
import {
  isTruthyJsonValue,
  normalizeUtcTimestamp,
} from './programme-domain.js';

@Injectable()
export class ProgrammePolicyService {
  constructor(
    private readonly mutations: ProgrammeMutationRepository,
    private readonly reads: ProgrammeReadRepository,
    private readonly policies: ProgrammePolicyRepository,
    private readonly programmes: ProgrammeRepository,
  ) {}

  async list(
    authorization: string | undefined,
    slug: string,
    query: { type?: string; page?: string; pageSize?: string },
  ) {
    this.authorizeAdmin(authorization, slug);
    const page = parsePageInteger(query.page, 1);
    const pageSize = parsePageInteger(query.pageSize, 50, 100);
    const start = pageOffset(page, pageSize);
    const { items, total } = await this.reads.listPolicyDraftPage(
      slug,
      query.type,
      pageSize,
      start,
    );
    return {
      items,
      page,
      pageSize,
      total,
      nextPage: nextPageIfMore(page, pageSize, total),
    };
  }

  async save(
    authorization: string | undefined,
    slug: string,
    rawBody: unknown,
    idempotencyKey?: string,
  ) {
    this.authorizeAdmin(authorization, slug);
    const body = await validatePolicyBody(rawBody, SaveProgrammePolicyDraftDto);
    if (
      !body.type ||
      !body.name ||
      !isTruthyJsonValue(body.schema) ||
      typeof body.schema !== 'object'
    ) {
      throw new BadRequestException(
        'type, name, and schema are required; schema must be an object',
      );
    }
    return this.policies.mutate(idempotencyKey, async (client) => {
      const draftId = body.draftId || randomUUID();
      await this.policies.lockRecord(client, draftId);
      const previous = await this.policies.find(client, draftId);
      if (
        previous &&
        !['DRAFT', 'CHANGES_REQUESTED'].includes(previous.status)
      ) {
        throw new BadRequestException(
          'only draft policy versions can be edited',
        );
      }
      const createdAt = previous?.createdAt ?? (await getUtcTimestamp(client));
      const draft: ProgrammePolicyDraft = {
        ...(previous ?? {
          id: draftId,
          programmeSlug: slug,
          status: 'DRAFT',
          reviewHistory: [],
          createdAt,
        }),
        type: body.type,
        name: body.name,
        schema: body.schema,
        effectiveFrom: body.effectiveFrom
          ? normalizeUtcTimestamp(body.effectiveFrom)
          : null,
        updatedAt: await getUtcTimestamp(client),
      };
      await this.policies.save(client, draft);
      await this.policies.recordEvent(
        client,
        'programme.policy-draft.saved.v1',
        draftId,
        draft,
      );
      return { statusCode: previous ? 200 : 201, draft };
    });
  }

  async submit(
    authorization: string | undefined,
    slug: string,
    draftId: string,
    idempotencyKey?: string,
  ) {
    this.authorizeAdmin(authorization, slug);
    return this.policies.mutate(idempotencyKey, async (client) => {
      await this.policies.lockRecord(client, draftId);
      const draft = await this.requireDraft(client, draftId);
      if (
        draft.programmeSlug !== slug ||
        !['DRAFT', 'CHANGES_REQUESTED'].includes(draft.status)
      ) {
        throw new BadRequestException('only draft policies can be submitted');
      }
      draft.status = 'UNDER_REVIEW';
      draft.submittedAt = await getUtcTimestamp(client);
      draft.updatedAt = await getUtcTimestamp(client);
      draft.reviewHistory.push({
        action: 'SUBMITTED',
        occurredAt: draft.submittedAt,
      });
      await this.policies.save(client, draft);
      return draft;
    });
  }

  async review(
    authorization: string | undefined,
    slug: string,
    draftId: string,
    rawBody: unknown,
    idempotencyKey?: string,
  ) {
    this.authorizeAdmin(authorization, slug);
    const body = await validatePolicyBody(
      rawBody,
      ReviewProgrammePolicyDraftDto,
    );
    return this.policies.mutate(idempotencyKey, async (client) => {
      await this.policies.lockRecord(client, draftId);
      const draft = await this.requireDraft(client, draftId);
      if (draft.programmeSlug !== slug || draft.status !== 'UNDER_REVIEW') {
        throw new BadRequestException(
          'only policies under review can be decided',
        );
      }
      draft.status = body.decision;
      draft.reviewedAt = await getUtcTimestamp(client);
      draft.updatedAt = await getUtcTimestamp(client);
      draft.reviewHistory.push({
        action: body.decision,
        reviewerId: body.reviewerId,
        note: body.note ?? null,
        occurredAt: draft.reviewedAt,
      });
      await this.policies.save(client, draft);
      return draft;
    });
  }

  async publish(
    authorization: string | undefined,
    slug: string,
    draftId: string,
    rawBody: unknown,
    idempotencyKey?: string,
  ) {
    this.authorizeAdmin(authorization, slug);
    const body = await validatePolicyBody(
      rawBody,
      PublishProgrammePolicyDraftDto,
    );
    const effectiveFrom = normalizeUtcTimestamp(body.effectiveFrom);
    return this.mutations.mutate(idempotencyKey, async (client) => {
      await this.policies.lockRecord(client, draftId);
      const draft = await this.requireDraft(client, draftId);
      if (draft.programmeSlug !== slug || draft.status !== 'APPROVED') {
        throw new BadRequestException(
          'only approved policies can be published',
        );
      }
      const programme = await this.programmes.getInTransaction(client, slug);
      if (!programme) throw new NotFoundException(pythonKeyErrorDetail(slug));
      draft.status = 'PUBLISHED';
      draft.effectiveFrom = effectiveFrom;
      draft.publishedAt = await getUtcTimestamp(client);
      draft.publisherId = body.publisherId;
      draft.updatedAt = await getUtcTimestamp(client);
      draft.reviewHistory.push({
        action: 'PUBLISHED',
        publisherId: body.publisherId,
        effectiveFrom,
        occurredAt: draft.publishedAt,
      });
      if (draft.type === 'RULES') {
        programme.rules = Object.hasOwn(draft.schema, 'rules')
          ? draft.schema.rules
          : draft.schema;
        programme.policyVersion = nextPolicyVersion(programme.policyVersion);
      } else {
        const awards = Array.isArray(programme.awards)
          ? (programme.awards as Record<string, unknown>[])
          : [];
        awards.push({
          ...draft.schema,
          draftId: draft.id,
          effectiveFrom,
        });
        programme.awards = awards;
      }
      programme.updatedAt = await getUtcTimestamp(client);
      await this.programmes.save(client, programme);
      await this.policies.save(client, draft);
      await this.mutations.recordEvent(
        client,
        'programme.policy-draft.published.v1',
        'policy_draft',
        draft.id,
        draft,
      );
      return { draft, programme };
    });
  }

  async patch(
    authorization: string | undefined,
    slug: string,
    draftId: string,
    rawBody: unknown,
    idempotencyKey?: string,
  ) {
    const body = policyBodyRecord(rawBody);
    if (body.status === 'UNDER_REVIEW') {
      return this.submit(authorization, slug, draftId, idempotencyKey);
    }
    if (body.status === 'APPROVED' || body.status === 'CHANGES_REQUESTED') {
      return this.review(
        authorization,
        slug,
        draftId,
        {
          decision: body.status,
          reviewerId: body.reviewerId as string,
          note: body.note as string | null | undefined,
        },
        idempotencyKey,
      );
    }
    if (body.status === 'PUBLISHED') {
      return this.publish(
        authorization,
        slug,
        draftId,
        {
          effectiveFrom: body.effectiveFrom as string,
          publisherId: body.publisherId as string,
        },
        idempotencyKey,
      );
    }
    const current = await this.policies.get(draftId);
    if (!current) throw new BadRequestException('policy draft not found');
    return this.save(
      authorization,
      slug,
      {
        draftId,
        type: body.type !== undefined ? body.type : current.type,
        name: body.name !== undefined ? body.name : current.name,
        schema: body.schema !== undefined ? body.schema : current.schema,
        effectiveFrom:
          body.effectiveFrom !== undefined
            ? body.effectiveFrom
            : (current.effectiveFrom as string | null | undefined),
      },
      idempotencyKey,
    );
  }

  private authorizeAdmin(authorization: string | undefined, slug: string) {
    const scopes = new Set(verifyAccessToken(authorization).scp);
    if (
      scopes.has('*') ||
      scopes.has('programme.admin') ||
      scopes.has(`programme:${slug}:programme_admin`)
    ) {
      return;
    }
    throw new ForbiddenException('programme administration scope is required');
  }

  private async requireDraft(
    client: import('pg').PoolClient,
    draftId: string,
  ): Promise<ProgrammePolicyDraft> {
    const draft = await this.policies.find(client, draftId);
    if (!draft) throw new NotFoundException(pythonKeyErrorDetail(draftId));
    draft.reviewHistory ??= [];
    return draft;
  }
}

const policyBodyValidationPipe = new ValidationPipe({
  transform: true,
  whitelist: true,
});

async function validatePolicyBody<T>(
  body: unknown,
  metatype: new () => T,
): Promise<T> {
  return (await policyBodyValidationPipe.transform(body, {
    type: 'body',
    metatype,
  })) as T;
}

function policyBodyRecord(body: unknown): Record<string, unknown> {
  if (!isTruthyJsonValue(body)) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('policy draft body must be an object');
  }
  return body as Record<string, unknown>;
}
