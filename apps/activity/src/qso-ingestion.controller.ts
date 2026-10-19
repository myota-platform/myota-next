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

  @Get(':ingestionId')
  get(
    @Headers('authorization') authorization: string | undefined,
    @Param('ingestionId') id: string,
  ) {
    return this.activity.getJob(authorization, id);
  }
}
