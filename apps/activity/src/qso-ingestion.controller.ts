import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { ActivityService } from './activity.service.js';

@Controller('qso-ingestions')
export class QsoIngestionController {
  constructor(private readonly activity: ActivityService) {}

  @Post()
  @HttpCode(202)
  enqueue(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: Record<string, any>,
  ) {
    return this.activity.enqueueQsoIngestion(authorization, key, body);
  }

  @Post('csv')
  @HttpCode(202)
  enqueueCsv(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: Record<string, any>,
  ) {
    return this.activity.enqueueCsvQsoIngestion(authorization, key, body);
  }

  @Get(':ingestionId')
  get(@Param('ingestionId') id: string) {
    return this.activity.getJob(id);
  }
}
