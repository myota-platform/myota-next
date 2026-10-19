import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { AwardsService } from './awards.service.js';

@Controller('awards')
export class AwardsController {
  constructor(private readonly awards: AwardsService) {}

  @Get()
  list(
    @Headers('authorization') authorization: string | undefined,
    @Query()
    query: {
      programme?: string;
      category?: string;
      page?: string;
      pageSize?: string;
    },
  ) {
    return this.awards.list(authorization, query);
  }

  @Post()
  create(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: Record<string, any>,
  ) {
    return this.awards.save(authorization, undefined, body);
  }

  @Post('evaluation-jobs')
  @HttpCode(202)
  createEvaluation(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: Record<string, any>,
  ) {
    return this.awards.createEvaluationJob(authorization, key, body);
  }

  @Get('evaluation-jobs/:jobId')
  getEvaluation(
    @Headers('authorization') authorization: string | undefined,
    @Param('jobId') jobId: string,
  ) {
    return this.awards.getAwardJob(authorization, jobId);
  }

  @Get('progress')
  progress(
    @Headers('authorization') authorization: string | undefined,
    @Query('awardId') awardId = '',
    @Query('participantId') participantId = '',
  ) {
    return this.awards.progress(authorization, awardId, participantId);
  }

  @Post('previews')
  @HttpCode(200)
  preview(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: Record<string, any>,
  ) {
    return this.awards.preview(authorization, body);
  }

  @Get('requests')
  listRequests(
    @Headers('authorization') authorization: string | undefined,
    @Query()
    query: { subjectId?: string; page?: string; pageSize?: string },
  ) {
    return this.awards.listRequests(authorization, query);
  }

  @Post('requests')
  requestAward(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: Record<string, any>,
  ) {
    return this.awards.requestAward(authorization, body);
  }

  @Post('requests/:requestId/issuances')
  issueRequest(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('requestId') requestId: string,
    @Body() body: Record<string, any>,
  ) {
    return this.awards.issueRequest(authorization, key, requestId, body);
  }

  @Get('issuances')
  listIssuances(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: { page?: string; pageSize?: string },
  ) {
    return this.awards.listIssuances(authorization, query);
  }

  @Post('issuances/:issuanceId/render-jobs')
  @HttpCode(202)
  createRenderJob(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('issuanceId') issuanceId: string,
  ) {
    return this.awards.createRenderJob(authorization, key, issuanceId);
  }

  @Get('issuances/:issuanceId/render-jobs/:jobId')
  getRenderJob(
    @Headers('authorization') authorization: string | undefined,
    @Param('issuanceId') issuanceId: string,
    @Param('jobId') jobId: string,
  ) {
    return this.awards.getRenderJob(authorization, issuanceId, jobId);
  }

  @Get('issuances/:issuanceId/artifact')
  getArtifact(
    @Headers('authorization') authorization: string | undefined,
    @Param('issuanceId') issuanceId: string,
  ) {
    return this.awards.getArtifact(authorization, issuanceId);
  }

  @Get('assets')
  listAssets(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: { page?: string; pageSize?: string },
  ) {
    return this.awards.listAssets(authorization, query);
  }

  @Post('assets')
  registerAsset(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: Record<string, any>,
  ) {
    return this.awards.registerAsset(authorization, body);
  }

  @Get('assets/:assetId/content')
  getAssetContent(
    @Headers('authorization') authorization: string | undefined,
    @Param('assetId') assetId: string,
  ) {
    return this.awards.getAssetContent(authorization, assetId);
  }

  @Put('assets/:assetId/content')
  async putAssetContent(
    @Headers('authorization') authorization: string | undefined,
    @Headers('content-type') contentType: string | undefined,
    @Param('assetId') assetId: string,
    @Req() request: Request,
  ) {
    const content = await readBoundedBody(request, 20 * 1024 * 1024);
    return this.awards.putAssetContent(
      authorization,
      assetId,
      contentType?.split(';')[0]?.trim(),
      content,
    );
  }

  @Get(':awardId')
  get(
    @Headers('authorization') authorization: string | undefined,
    @Param('awardId') id: string,
  ) {
    return this.awards.get(authorization, id);
  }

  @Patch(':awardId')
  patch(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('awardId') id: string,
    @Body() body: Record<string, any>,
  ) {
    return this.awards.patch(authorization, key, id, body);
  }

  @Post(':awardId/submit')
  @HttpCode(200)
  submit(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('awardId') id: string,
  ) {
    return this.awards.submit(authorization, id, key);
  }

  @Post(':awardId/review')
  @HttpCode(200)
  review(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('awardId') id: string,
    @Body() body: Record<string, any>,
  ) {
    return this.awards.review(authorization, id, body, key);
  }

  @Post(':awardId/publish')
  @HttpCode(200)
  publish(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('awardId') id: string,
    @Body() body: Record<string, any>,
  ) {
    return this.awards.publish(authorization, id, body, key);
  }

  @Post(':awardId/retire')
  @HttpCode(200)
  retire(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('awardId') id: string,
    @Body() body: Record<string, any>,
  ) {
    return this.awards.retire(authorization, id, body, key);
  }

  @Post(':awardId/recalculation-jobs')
  @HttpCode(202)
  recalculate(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('awardId') id: string,
    @Body() body: Record<string, any>,
  ) {
    return this.awards.recalculate(authorization, key, id, body);
  }

  @Get(':awardId/recalculation-jobs/:jobId')
  getRecalculation(
    @Headers('authorization') authorization: string | undefined,
    @Param('jobId') jobId: string,
  ) {
    return this.awards.getAwardJob(authorization, jobId);
  }
}

async function readBoundedBody(request: Request, maximumBytes: number) {
  const declaredLength = Number(request.headers['content-length'] ?? 0);
  if (declaredLength > maximumBytes)
    throw new BadRequestException('image exceeds the configured upload limit');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += part.length;
    if (total > maximumBytes)
      throw new BadRequestException(
        'image exceeds the configured upload limit',
      );
    chunks.push(part);
  }
  return Buffer.concat(chunks, total);
}
