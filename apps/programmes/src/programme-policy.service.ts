import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { verifyAccessToken } from '@app/platform/access-token.js';
import { ProgrammeStateRepository } from './programme-state.repository.js';
import type { ProgrammeState } from './programme-state.repository.js';
import type {
  PatchProgrammePolicyDraftDto,
  PublishProgrammePolicyDraftDto,
  ReviewProgrammePolicyDraftDto,
  SaveProgrammePolicyDraftDto,
} from './programmes.dto.js';

type PolicyDraft = Record<string, unknown> & {
  id: string;
  programmeSlug: string;
  type: 'RULES' | 'AWARD';
  name: string;
  schema: Record<string, unknown>;
  status: string;
  reviewHistory: Record<string, unknown>[];
  updatedAt: string;
};

@Injectable()
export class ProgrammePolicyService {
  constructor(private readonly state: ProgrammeStateRepository) {}

  async list(
    authorization: string | undefined,
    slug: string,
    query: { type?: string; page?: string; pageSize?: string },
  ) {
    this.authorizeAdmin(authorization, slug);
    const page = parsePage(query.page, 1);
    const pageSize = Math.min(100, parsePage(query.pageSize, 50));
    const state = await this.state.load();
    const items = Object.values(policyDraftBucket(state)).filter(
      (draft) =>
        draft.programmeSlug === slug &&
        (!query.type || draft.type === query.type),
    );
    items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const total = items.length;
    const start = (page - 1) * pageSize;
    return {
      items: items.slice(start, start + pageSize),
      page,
      pageSize,
      total,
      nextPage: start + pageSize < total ? page + 1 : null,
    };
  }

  async save(
    authorization: string | undefined,
    slug: string,
    body: SaveProgrammePolicyDraftDto,
    idempotencyKey?: string,
  ) {
    this.authorizeAdmin(authorization, slug);
    if (
      !body.type ||
      !body.name ||
      !body.schema ||
      typeof body.schema !== 'object'
    ) {
      throw new BadRequestException(
        'type, name, and schema are required; schema must be an object',
      );
    }
    return this.state.mutate(idempotencyKey, async (client, state) => {
      const bucket = policyDraftBucket(state);
      const draftId = body.draftId ?? randomUUID();
      const previous = bucket[draftId];
      if (
        previous &&
        !['DRAFT', 'CHANGES_REQUESTED'].includes(previous.status)
      ) {
        throw new BadRequestException(
          'only draft policy versions can be edited',
        );
      }
      const now = new Date().toISOString();
      const draft: PolicyDraft = {
        ...(previous ?? {
          id: draftId,
          programmeSlug: slug,
          status: 'DRAFT',
          reviewHistory: [],
          createdAt: now,
        }),
        type: body.type,
        name: body.name,
        schema: body.schema,
        effectiveFrom: body.effectiveFrom
          ? normalizeUtcTimestamp(body.effectiveFrom)
          : null,
        updatedAt: now,
      };
      bucket[draftId] = draft;
      await this.state.recordEvent(
        client,
        state,
        'programme.policy-draft.saved.v1',
        'policy_draft',
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
    return this.state.mutate(idempotencyKey, async (_client, state) => {
      const draft = requireDraft(policyDraftBucket(state), draftId);
      if (
        draft.programmeSlug !== slug ||
        !['DRAFT', 'CHANGES_REQUESTED'].includes(draft.status)
      ) {
        throw new BadRequestException('only draft policies can be submitted');
      }
      const now = new Date().toISOString();
      draft.status = 'UNDER_REVIEW';
      draft.submittedAt = now;
      draft.updatedAt = now;
      draft.reviewHistory.push({ action: 'SUBMITTED', occurredAt: now });
      return draft;
    });
  }

  async review(
    authorization: string | undefined,
    slug: string,
    draftId: string,
    body: ReviewProgrammePolicyDraftDto,
    idempotencyKey?: string,
  ) {
    this.authorizeAdmin(authorization, slug);
    return this.state.mutate(idempotencyKey, async (_client, state) => {
      const draft = requireDraft(policyDraftBucket(state), draftId);
      if (draft.programmeSlug !== slug || draft.status !== 'UNDER_REVIEW') {
        throw new BadRequestException(
          'only policies under review can be decided',
        );
      }
      const now = new Date().toISOString();
      draft.status = body.decision;
      draft.reviewedAt = now;
      draft.updatedAt = now;
      draft.reviewHistory.push({
        action: body.decision,
        reviewerId: body.reviewerId,
        note: body.note ?? null,
        occurredAt: now,
      });
      return draft;
    });
  }

  async publish(
    authorization: string | undefined,
    slug: string,
    draftId: string,
    body: PublishProgrammePolicyDraftDto,
    idempotencyKey?: string,
  ) {
    this.authorizeAdmin(authorization, slug);
    const effectiveFrom = normalizeUtcTimestamp(body.effectiveFrom);
    return this.state.mutate(idempotencyKey, async (client, state) => {
      const draft = requireDraft(policyDraftBucket(state), draftId);
      if (draft.programmeSlug !== slug || draft.status !== 'APPROVED') {
        throw new BadRequestException(
          'only approved policies can be published',
        );
      }
      const programme = state.items?.[slug];
      if (!programme) throw new NotFoundException('programme not found');
      const now = new Date().toISOString();
      draft.status = 'PUBLISHED';
      draft.effectiveFrom = effectiveFrom;
      draft.publishedAt = now;
      draft.publisherId = body.publisherId;
      draft.updatedAt = now;
      draft.reviewHistory.push({
        action: 'PUBLISHED',
        publisherId: body.publisherId,
        effectiveFrom,
        occurredAt: now,
      });
      if (draft.type === 'RULES') {
        programme.rules = draft.schema.rules ?? draft.schema;
        programme.policyVersion = (programme.policyVersion ?? 1) + 1;
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
      programme.updatedAt = now;
      await this.state.recordEvent(
        client,
        state,
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
    body: PatchProgrammePolicyDraftDto,
    idempotencyKey?: string,
  ) {
    if (body.status === 'UNDER_REVIEW') {
      return this.submit(authorization, slug, draftId, idempotencyKey);
    }
    if (body.status === 'APPROVED' || body.status === 'CHANGES_REQUESTED') {
      if (!body.reviewerId) {
        throw new BadRequestException('reviewerId is required');
      }
      return this.review(
        authorization,
        slug,
        draftId,
        {
          decision: body.status,
          reviewerId: body.reviewerId,
          note: body.note,
        },
        idempotencyKey,
      );
    }
    if (body.status === 'PUBLISHED') {
      if (!body.effectiveFrom || !body.publisherId) {
        throw new BadRequestException(
          'effectiveFrom and publisherId are required',
        );
      }
      return this.publish(
        authorization,
        slug,
        draftId,
        { effectiveFrom: body.effectiveFrom, publisherId: body.publisherId },
        idempotencyKey,
      );
    }
    const current = policyDraftBucket(await this.state.load())[draftId];
    if (!current) throw new BadRequestException('policy draft not found');
    return this.save(
      authorization,
      slug,
      {
        draftId,
        type: body.type ?? current.type,
        name: body.name ?? current.name,
        schema: body.schema ?? current.schema,
        effectiveFrom:
          'effectiveFrom' in body
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
}

function policyDraftBucket(state: ProgrammeState): Record<string, PolicyDraft> {
  state.data ??= {};
  const value = state.data.policyDrafts;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, PolicyDraft>;
  }
  const bucket: Record<string, PolicyDraft> = {};
  state.data.policyDrafts = bucket;
  return bucket;
}

function requireDraft(
  bucket: Record<string, PolicyDraft>,
  draftId: string,
): PolicyDraft {
  const draft = bucket[draftId];
  if (!draft) throw new NotFoundException('policy draft not found');
  draft.reviewHistory ??= [];
  return draft;
}

function normalizeUtcTimestamp(value: string): string {
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const normalized = hasTimezone
    ? value
    : value.includes('T')
      ? `${value}Z`
      : `${value}T00:00:00Z`;
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) {
    throw new BadRequestException('effectiveFrom must be a valid timestamp');
  }
  return date.toISOString();
}

function parsePage(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new BadRequestException('page and pageSize must be integers');
  }
  return Math.max(1, parsed);
}
