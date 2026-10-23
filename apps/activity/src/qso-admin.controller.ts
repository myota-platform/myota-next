import { Controller, Get, Headers, Query } from '@nestjs/common';
import { firstQueryValue } from '@app/platform/query.js';
import { ActivityService } from './activity.service.js';

@Controller('qso-corrections')
export class QsoCorrectionAdminController {
  constructor(private readonly activity: ActivityService) {}

  @Get()
  list(
    @Headers('authorization') authorization: string | undefined,
    @Query()
    query: {
      status?: string | string[];
      programme?: string | string[];
      page?: string | string[];
      pageSize?: string | string[];
    },
  ) {
    return this.activity.listCorrections(authorization, {
      status: firstQueryValue(query.status),
      programme: firstQueryValue(query.programme),
      page: firstQueryValue(query.page),
      pageSize: firstQueryValue(query.pageSize),
    });
  }
}
