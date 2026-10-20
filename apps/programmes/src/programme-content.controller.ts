import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
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
    @Body() body: SaveProgrammeContentDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { statusCode, content } = await this.content.save(
      authorization,
      slug,
      body,
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
    @Param('contentId', new ParseUUIDPipe()) contentId: string,
  ) {
    return this.content.submit(authorization, slug, contentId, idempotencyKey);
  }

  @Post(':contentId/review')
  @HttpCode(200)
  review(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('slug') slug: string,
    @Param('contentId', new ParseUUIDPipe()) contentId: string,
    @Body() body: ReviewProgrammeContentDto,
  ) {
    return this.content.review(
      authorization,
      slug,
      contentId,
      body,
      idempotencyKey,
    );
  }

  @Post(':contentId/publish')
  @HttpCode(200)
  publish(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('slug') slug: string,
    @Param('contentId', new ParseUUIDPipe()) contentId: string,
    @Body() body: PublishProgrammeContentDto,
  ) {
    return this.content.publish(
      authorization,
      slug,
      contentId,
      body,
      idempotencyKey,
    );
  }

  @Patch(':contentId')
  @HttpCode(200)
  patch(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('slug') slug: string,
    @Param('contentId', new ParseUUIDPipe()) contentId: string,
    @Body() body: PatchProgrammeContentDto,
  ) {
    return this.content.patch(
      authorization,
      slug,
      contentId,
      body,
      idempotencyKey,
    );
  }
}
