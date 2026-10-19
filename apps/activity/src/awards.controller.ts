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
} from '@nestjs/common';
import { AwardsService } from './awards.service.js';

@Controller('v1/awards')
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
