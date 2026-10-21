import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { firstQueryValue } from '@app/platform/query.js';
import {
  PatchProgrammeContentDto,
  PublishProgrammeContentDto,
  ReviewProgrammeContentDto,
  SaveProgrammeContentDto,
} from './programmes.dto.js';
import { ProgrammeContentService } from './programme-content.service.js';

@Controller('programmes/:slug/content')
export class ProgrammeContentController {
  constructor(private readonly content: ProgrammeContentService) {}

  @Get('coverage')
  coverage(
    @Headers('authorization') authorization: string | undefined,
    @Param('slug') slug: string,
  ) {
    return this.content.coverage(authorization, slug);
  }

  @Get()
  list(
    @Headers('authorization') authorization: string | undefined,
    @Param('slug') slug: string,
    @Query()
    query: {
      locale?: string | string[];
      status?: string | string[];
      page?: string | string[];
      pageSize?: string | string[];
    },
  ) {
    return this.content.list(authorization, slug, {
      locale: firstQueryValue(query.locale),
      status: firstQueryValue(query.status),
      page: firstQueryValue(query.page),
      pageSize: firstQueryValue(query.pageSize),
    });
  }

  @Post()
  async save(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('slug') slug: string,
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { statusCode, content } = await this.content.save(
      authorization,
      slug,
      body as unknown as SaveProgrammeContentDto,
      idempotencyKey,
    );
    response.status(statusCode);
    return content;
  }

  @Post(':contentId/submit')
  @HttpCode(200)
  submit(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('slug') slug: string,
    @Param('contentId') contentId: string,
  ) {
    return this.content.submit(authorization, slug, contentId, idempotencyKey);
  }

  @Post(':contentId/review')
  @HttpCode(200)
  review(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('slug') slug: string,
    @Param('contentId') contentId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.content.review(
      authorization,
      slug,
      contentId,
      body as unknown as ReviewProgrammeContentDto,
      idempotencyKey,
    );
  }

  @Post(':contentId/publish')
  @HttpCode(200)
  publish(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('slug') slug: string,
    @Param('contentId') contentId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.content.publish(
      authorization,
      slug,
      contentId,
      body as unknown as PublishProgrammeContentDto,
      idempotencyKey,
    );
  }

  @Patch(':contentId')
  @HttpCode(200)
  patch(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('slug') slug: string,
    @Param('contentId') contentId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.content.patch(
      authorization,
      slug,
      contentId,
      body as unknown as PatchProgrammeContentDto,
      idempotencyKey,
    );
  }
}
