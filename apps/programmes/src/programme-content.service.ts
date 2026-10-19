import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { verifyAccessToken } from '@app/platform/access-token.js';
import { parsePageInteger } from '@app/platform/pagination.js';
import { ProgrammeStateRepository } from './programme-state.repository.js';
import type { ProgrammeState } from './programme-state.repository.js';
import type {
  PatchProgrammeContentDto,
  PublishProgrammeContentDto,
  ReviewProgrammeContentDto,
  SaveProgrammeContentDto,
} from './programmes.dto.js';
import {
  isTruthyJsonValue,
  normalizeUtcTimestamp,
} from './programme-domain.js';

type ContentRecord = Record<string, unknown> & {
  id: string;
  programmeSlug: string;
  key: string;
  locale: string;
  status: string;
  reviewHistory: Record<string, unknown>[];
  updatedAt: string;
};

@Injectable()
export class ProgrammeContentService {
  constructor(private readonly state: ProgrammeStateRepository) {}

  async list(
    authorization: string | undefined,
    slug: string,
    query: {
      locale?: string;
      status?: string;
      page?: string;
      pageSize?: string;
    },
  ) {
    this.authorizeAdmin(authorization, slug);
    const page = parsePageInteger(query.page, 1);
    const pageSize = Math.min(100, parsePageInteger(query.pageSize, 50));
    const state = await this.state.load();
    const items = Object.values(contentBucket(state)).filter(
      (item) =>
        item.programmeSlug === slug &&
        (!query.locale || item.locale === query.locale) &&
        (!query.status || item.status === query.status),
    );
    items.sort((left, right) =>
      `${left.key}\u0000${left.locale}`.localeCompare(
        `${right.key}\u0000${right.locale}`,
      ),
    );
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

  async coverage(authorization: string | undefined, slug: string) {
    this.authorizeAdmin(authorization, slug);
    const state = await this.state.load();
    const programme = state.items?.[slug];
    if (!programme) throw new NotFoundException('programme not found');
    const content = Object.values(contentBucket(state)).filter(
      (item) => item.programmeSlug === slug,
    );
    const keys = [...new Set(content.map((item) => item.key))].sort();
    const programmeLocales = programme.locales;
    const locales =
      Array.isArray(programmeLocales) && programmeLocales.length > 0
        ? programmeLocales.filter(
            (locale): locale is string => typeof locale === 'string',
          )
        : [...new Set(content.map((item) => item.locale))].sort();
    const effectiveLocales = locales.length ? locales : ['en'];
    const byLocale = effectiveLocales.map((locale) => {
      const published = new Set(
        content
          .filter(
            (item) => item.locale === locale && item.status === 'PUBLISHED',
          )
          .map((item) => item.key),
      );
      return {
        locale,
        published: published.size,
        total: keys.length,
        coveragePercent: keys.length
          ? Math.round((published.size / keys.length) * 100)
          : 0,
        missingKeys: keys.filter((key) => !published.has(key)),
      };
    });
    return { programmeSlug: slug, locales: byLocale, totalKeys: keys.length };
  }

  async save(
    authorization: string | undefined,
    slug: string,
    body: SaveProgrammeContentDto,
    idempotencyKey?: string,
  ) {
    this.authorizeAdmin(authorization, slug);
    this.requireContent(body.key, body.locale, body.value);
    return this.state.mutate(idempotencyKey, async (client, state) => {
      const content = contentBucket(state);
      const contentId = body.contentId ?? randomUUID();
      const previous = content[contentId];
      if (previous && previous.programmeSlug !== slug) {
        throw new BadRequestException('content does not belong to programme');
      }
      if (
        previous &&
        !['DRAFT', 'CHANGES_REQUESTED'].includes(previous.status)
      ) {
        throw new BadRequestException('only draft content can be edited');
      }
      const now = new Date().toISOString();
      const record: ContentRecord = {
        ...(previous ?? {
          id: contentId,
          programmeSlug: slug,
          status: 'DRAFT',
          reviewHistory: [],
          createdAt: now,
        }),
        key: body.key,
        locale: body.locale,
        value: body.value,
        fallbackLocale: body.fallbackLocale ?? null,
        updatedAt: now,
      };
      content[contentId] = record;
      await this.state.recordEvent(
        client,
        state,
        'programme.content.saved.v1',
        'content',
        contentId,
        record,
      );
      return { statusCode: previous ? 200 : 201, content: record };
    });
  }

  async submit(
    authorization: string | undefined,
    slug: string,
    contentId: string,
    idempotencyKey?: string,
  ) {
    this.authorizeAdmin(authorization, slug);
    return this.state.mutate(idempotencyKey, async (client, state) => {
      const content = requireContentRecord(contentBucket(state), contentId);
      if (
        content.programmeSlug !== slug ||
        !['DRAFT', 'CHANGES_REQUESTED'].includes(content.status)
      ) {
        throw new BadRequestException('only draft content can be submitted');
      }
      const now = new Date().toISOString();
      content.status = 'UNDER_REVIEW';
      content.submittedAt = now;
      content.updatedAt = now;
      content.reviewHistory.push({ action: 'SUBMITTED', occurredAt: now });
      await this.state.recordEvent(
        client,
        state,
        'programme.content.submitted.v1',
        'content',
        content.id,
        content,
      );
      return content;
    });
  }

  async review(
    authorization: string | undefined,
    slug: string,
    contentId: string,
    body: ReviewProgrammeContentDto,
    idempotencyKey?: string,
  ) {
    this.authorizeAdmin(authorization, slug);
    return this.state.mutate(idempotencyKey, async (client, state) => {
      const content = requireContentRecord(contentBucket(state), contentId);
      if (content.programmeSlug !== slug || content.status !== 'UNDER_REVIEW') {
        throw new BadRequestException(
          'only content under review can be decided',
        );
      }
      const now = new Date().toISOString();
      content.status = body.decision;
      content.reviewedAt = now;
      content.updatedAt = now;
      content.reviewHistory.push({
        action: body.decision,
        reviewerId: body.reviewerId,
        note: body.note ?? null,
        occurredAt: now,
      });
      await this.state.recordEvent(
        client,
        state,
        'programme.content.reviewed.v1',
        'content',
        content.id,
        content,
      );
      return content;
    });
  }

  async publish(
    authorization: string | undefined,
    slug: string,
    contentId: string,
    body: PublishProgrammeContentDto,
    idempotencyKey?: string,
  ) {
    this.authorizeAdmin(authorization, slug);
    const effectiveFrom = normalizeUtcTimestamp(body.effectiveFrom);
    return this.state.mutate(idempotencyKey, async (client, state) => {
      const content = requireContentRecord(contentBucket(state), contentId);
      if (content.programmeSlug !== slug || content.status !== 'APPROVED') {
        throw new BadRequestException('only approved content can be published');
      }
      const now = new Date().toISOString();
      content.status = 'PUBLISHED';
      content.effectiveFrom = effectiveFrom;
      content.publishedAt = now;
      content.publisherId = body.publisherId;
      content.updatedAt = now;
      content.reviewHistory.push({
        action: 'PUBLISHED',
        publisherId: body.publisherId,
        effectiveFrom,
        occurredAt: now,
      });
      await this.state.recordEvent(
        client,
        state,
        'programme.content.published.v1',
        'content',
        content.id,
        content,
      );
      return content;
    });
  }

  async patch(
    authorization: string | undefined,
    slug: string,
    contentId: string,
    body: PatchProgrammeContentDto,
    idempotencyKey?: string,
  ) {
    if (body.status === 'UNDER_REVIEW') {
      return this.submit(authorization, slug, contentId, idempotencyKey);
    }
    if (body.status === 'APPROVED' || body.status === 'CHANGES_REQUESTED') {
      if (!body.reviewerId) {
        throw new BadRequestException('reviewerId is required');
      }
      return this.review(
        authorization,
        slug,
        contentId,
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
        contentId,
        { effectiveFrom: body.effectiveFrom, publisherId: body.publisherId },
        idempotencyKey,
      );
    }
    const state = await this.state.load();
    const current = contentBucket(state)[contentId];
    if (!current) throw new BadRequestException('content not found');
    return this.save(
      authorization,
      slug,
      {
        contentId,
        key: 'key' in body ? (body.key as string) : current.key,
        locale: 'locale' in body ? (body.locale as string) : current.locale,
        value: 'value' in body ? body.value : current.value,
        fallbackLocale:
          'fallbackLocale' in body
            ? body.fallbackLocale
            : (current.fallbackLocale as string | null),
      },
      idempotencyKey,
    );
  }

  private requireContent(key: string, locale: string, value: unknown) {
    if (!key || !locale || !isTruthyJsonValue(value)) {
      throw new BadRequestException('key, locale, and value are required');
    }
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

function contentBucket(state: ProgrammeState): Record<string, ContentRecord> {
  state.data ??= {};
  const value = state.data.content;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, ContentRecord>;
  }
  const bucket: Record<string, ContentRecord> = {};
  state.data.content = bucket;
  return bucket;
}

function requireContentRecord(
  bucket: Record<string, ContentRecord>,
  contentId: string,
): ContentRecord {
  const content = bucket[contentId];
  if (!content) throw new NotFoundException('content not found');
  content.reviewHistory ??= [];
  return content;
}
