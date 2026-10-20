import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { verifyAccessToken } from '@app/platform/access-token.js';
import { parsePageInteger } from '@app/platform/pagination.js';
import { ProgrammeReadRepository } from './programme-read.repository.js';
import {
  ProgrammeContentRepository,
  type ProgrammeContentRecord,
} from './programme-content.repository.js';
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

@Injectable()
export class ProgrammeContentService {
  constructor(
    private readonly contents: ProgrammeContentRepository,
    private readonly reads: ProgrammeReadRepository,
  ) {}

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
    const pageSize = parsePageInteger(query.pageSize, 50, 100);
    const start = (page - 1) * pageSize;
    const { items, total } = await this.reads.listContentPage(
      slug,
      query.locale,
      query.status,
      pageSize,
      start,
    );
    return {
      items,
      page,
      pageSize,
      total,
      nextPage: start + pageSize < total ? page + 1 : null,
    };
  }

  async coverage(authorization: string | undefined, slug: string) {
    this.authorizeAdmin(authorization, slug);
    const coverage = await this.reads.getContentCoverage(slug);
    if (!coverage.programmeFound)
      throw new NotFoundException('programme not found');
    return {
      programmeSlug: slug,
      locales: coverage.locales,
      totalKeys: coverage.totalKeys,
    };
  }

  async publicContent(slug: string, locale?: string) {
    const result = await this.reads.listPublishedContent(slug, locale);
    if (!result.programmeFound)
      throw new NotFoundException('programme not found');
    return { programmeSlug: slug, locale: locale ?? null, items: result.items };
  }

  async save(
    authorization: string | undefined,
    slug: string,
    body: SaveProgrammeContentDto,
    idempotencyKey?: string,
  ) {
    this.authorizeAdmin(authorization, slug);
    this.requireContent(body.key, body.locale, body.value);
    return this.contents.mutate(idempotencyKey, async (client) => {
      const contentId = body.contentId ?? randomUUID();
      await this.contents.lockRecord(client, contentId);
      const previous = await this.contents.find(client, contentId);
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
      const record: ProgrammeContentRecord = {
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
      await this.contents.save(client, record);
      await this.contents.recordEvent(
        client,
        'programme.content.saved.v1',
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
    return this.contents.mutate(idempotencyKey, async (client) => {
      await this.contents.lockRecord(client, contentId);
      const content = await this.requireContentRecord(client, contentId);
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
      await this.contents.save(client, content);
      await this.contents.recordEvent(
        client,
        'programme.content.submitted.v1',
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
    return this.contents.mutate(idempotencyKey, async (client) => {
      await this.contents.lockRecord(client, contentId);
      const content = await this.requireContentRecord(client, contentId);
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
      await this.contents.save(client, content);
      await this.contents.recordEvent(
        client,
        'programme.content.reviewed.v1',
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
    return this.contents.mutate(idempotencyKey, async (client) => {
      await this.contents.lockRecord(client, contentId);
      const content = await this.requireContentRecord(client, contentId);
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
      await this.contents.save(client, content);
      await this.contents.recordEvent(
        client,
        'programme.content.published.v1',
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
    const current = await this.contents.get(contentId);
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

  private async requireContentRecord(
    client: import('pg').PoolClient,
    contentId: string,
  ): Promise<ProgrammeContentRecord> {
    const content = await this.contents.find(client, contentId);
    if (!content) throw new NotFoundException('content not found');
    content.reviewHistory ??= [];
    return content;
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
