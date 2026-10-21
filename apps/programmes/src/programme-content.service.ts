import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { verifyAccessToken } from '@app/platform/access-token.js';
import { pythonTruthy } from '@app/platform/python-truthiness.js';
import {
  nextPageIfMore,
  pageOffset,
  parsePageInteger,
} from '@app/platform/pagination.js';
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
    const start = pageOffset(page, pageSize);
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
      nextPage: nextPageIfMore(page, pageSize, total),
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
      const contentId = body.contentId || randomUUID();
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
      const createdAt = previous?.createdAt ?? new Date().toISOString();
      const record: ProgrammeContentRecord = {
        ...(previous ?? {
          id: contentId,
          programmeSlug: slug,
          status: 'DRAFT',
          reviewHistory: [],
          createdAt,
        }),
        key: body.key,
        locale: body.locale,
        value: body.value,
        fallbackLocale: body.fallbackLocale ?? null,
        updatedAt: new Date().toISOString(),
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
      content.status = 'UNDER_REVIEW';
      content.submittedAt = new Date().toISOString();
      content.updatedAt = new Date().toISOString();
      content.reviewHistory.push({
        action: 'SUBMITTED',
        occurredAt: content.submittedAt,
      });
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
    const decision = body.decision;
    const missing = [
      ...(!pythonTruthy(decision) ? ['decision'] : []),
      ...(!pythonTruthy(body.reviewerId) ? ['reviewerId'] : []),
    ];
    if (missing.length > 0) {
      throw new BadRequestException(
        `missing required fields: ${missing.join(', ')}`,
      );
    }
    if (decision !== 'APPROVED' && decision !== 'CHANGES_REQUESTED') {
      throw new BadRequestException(
        'decision must be APPROVED or CHANGES_REQUESTED',
      );
    }
    return this.contents.mutate(idempotencyKey, async (client) => {
      await this.contents.lockRecord(client, contentId);
      const content = await this.requireContentRecord(client, contentId);
      if (content.programmeSlug !== slug || content.status !== 'UNDER_REVIEW') {
        throw new BadRequestException(
          'only content under review can be decided',
        );
      }
      content.status = decision;
      content.reviewedAt = new Date().toISOString();
      content.updatedAt = new Date().toISOString();
      content.reviewHistory.push({
        action: decision,
        reviewerId: body.reviewerId,
        note: body.note ?? null,
        occurredAt: content.reviewedAt,
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
    const missing = [
      ...(!pythonTruthy(body.effectiveFrom) ? ['effectiveFrom'] : []),
      ...(!pythonTruthy(body.publisherId) ? ['publisherId'] : []),
    ];
    if (missing.length > 0) {
      throw new BadRequestException(
        `missing required fields: ${missing.join(', ')}`,
      );
    }
    const effectiveFrom = normalizeUtcTimestamp(String(body.effectiveFrom));
    return this.contents.mutate(idempotencyKey, async (client) => {
      await this.contents.lockRecord(client, contentId);
      const content = await this.requireContentRecord(client, contentId);
      if (content.programmeSlug !== slug || content.status !== 'APPROVED') {
        throw new BadRequestException('only approved content can be published');
      }
      content.status = 'PUBLISHED';
      content.effectiveFrom = effectiveFrom;
      content.publishedAt = new Date().toISOString();
      content.publisherId = body.publisherId;
      content.updatedAt = new Date().toISOString();
      content.reviewHistory.push({
        action: 'PUBLISHED',
        publisherId: body.publisherId,
        effectiveFrom,
        occurredAt: content.publishedAt,
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
      return this.publish(
        authorization,
        slug,
        contentId,
        {
          effectiveFrom: body.effectiveFrom,
          publisherId: body.publisherId,
        },
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
        key: body.key !== undefined ? (body.key as string) : current.key,
        locale:
          body.locale !== undefined ? (body.locale as string) : current.locale,
        value: body.value !== undefined ? body.value : current.value,
        fallbackLocale:
          body.fallbackLocale !== undefined
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
