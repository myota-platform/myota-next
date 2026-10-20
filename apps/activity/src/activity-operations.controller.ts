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
import { firstQueryValue } from '@app/platform/query.js';
import { ActivityService } from './activity.service.js';

@Controller()
export class ActivityOperationsController {
  constructor(private readonly activity: ActivityService) {}

  @Get('statistics')
  statistics(
    @Headers('authorization') authorization: string | undefined,
    @Query()
    query: {
      programme?: string | string[];
      page?: string | string[];
      pageSize?: string | string[];
    },
  ) {
    return this.activity.listStatistics(authorization, {
      programme: firstQueryValue(query.programme),
      page: firstQueryValue(query.page),
      pageSize: firstQueryValue(query.pageSize),
    });
  }

  @Post('statistics/rebuild-jobs')
  @HttpCode(202)
  rebuildStatistics(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: Record<string, any>,
  ) {
    return this.activity.createStatisticsRebuild(authorization, body);
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
    @Query()
    query: {
      recipientId?: string | string[];
      page?: string | string[];
      pageSize?: string | string[];
    },
  ) {
    return this.activity.listNotifications(authorization, {
      recipientId: firstQueryValue(query.recipientId),
      page: firstQueryValue(query.page),
      pageSize: firstQueryValue(query.pageSize),
    });
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
