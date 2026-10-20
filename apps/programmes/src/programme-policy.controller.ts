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
  PatchProgrammePolicyDraftDto,
  PublishProgrammePolicyDraftDto,
  ReviewProgrammePolicyDraftDto,
  SaveProgrammePolicyDraftDto,
} from './programmes.dto.js';
import { ProgrammePolicyService } from './programme-policy.service.js';

@Controller('programmes/:slug/policy-drafts')
export class ProgrammePolicyController {
  constructor(private readonly policies: ProgrammePolicyService) {}

  @Get()
  list(
    @Headers('authorization') authorization: string | undefined,
    @Param('slug') slug: string,
    @Query()
    query: {
      type?: string | string[];
      page?: string | string[];
      pageSize?: string | string[];
    },
  ) {
    return this.policies.list(authorization, slug, {
      type: firstQueryValue(query.type),
      page: firstQueryValue(query.page),
      pageSize: firstQueryValue(query.pageSize),
    });
  }

  @Post()
  async save(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('slug') slug: string,
    @Body() body: SaveProgrammePolicyDraftDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { statusCode, draft } = await this.policies.save(
      authorization,
      slug,
      body,
      idempotencyKey,
    );
    response.status(statusCode);
    return draft;
  }

  @Post(':draftId/submit')
  @HttpCode(200)
  submit(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('slug') slug: string,
    @Param('draftId') draftId: string,
  ) {
    return this.policies.submit(authorization, slug, draftId, idempotencyKey);
  }

  @Post(':draftId/review')
  @HttpCode(200)
  review(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('slug') slug: string,
    @Param('draftId') draftId: string,
    @Body() body: ReviewProgrammePolicyDraftDto,
  ) {
    return this.policies.review(
      authorization,
      slug,
      draftId,
      body,
      idempotencyKey,
    );
  }

  @Post(':draftId/publish')
  @HttpCode(200)
  publish(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('slug') slug: string,
    @Param('draftId') draftId: string,
    @Body() body: PublishProgrammePolicyDraftDto,
  ) {
    return this.policies.publish(
      authorization,
      slug,
      draftId,
      body,
      idempotencyKey,
    );
  }

  @Patch(':draftId')
  @HttpCode(200)
  patch(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('slug') slug: string,
    @Param('draftId') draftId: string,
    @Body() body: PatchProgrammePolicyDraftDto,
  ) {
    return this.policies.patch(
      authorization,
      slug,
      draftId,
      body,
      idempotencyKey,
    );
  }
}
