import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ActivityService } from './activity.service.js';

@Controller()
export class ActivityOperationsController {
  constructor(private readonly activity: ActivityService) {}

  @Get('statistics')
  statistics(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: { programme?: string; page?: string; pageSize?: string },
  ) {
    return this.activity.listStatistics(authorization, query);
  }

  @Post('statistics/rebuild-jobs')
  @HttpCode(202)
  rebuildStatistics(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: Record<string, any>,
  ) {
    return this.activity.createStatisticsRebuild(authorization, key, body);
  }

  @Get('statistics/rebuild-jobs/:jobId')
  getStatisticsRebuild(
    @Headers('authorization') authorization: string | undefined,
    @Param('jobId') jobId: string,
  ) {
    return this.activity.getJob(authorization, jobId);
  }

  @Get('notifications')
  notifications(
    @Headers('authorization') authorization: string | undefined,
    @Query('recipientId') recipientId?: string,
  ) {
    return this.activity.listNotifications(authorization, recipientId);
  }

  @Post('activity/work-jobs/:jobId/redrive')
  @HttpCode(202)
  redriveWorkJob(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('jobId') jobId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.activity.redriveWorkJob(authorization, key, jobId, body.reason);
  }
}
