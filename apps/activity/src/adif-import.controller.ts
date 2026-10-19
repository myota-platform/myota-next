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

@Controller('adif/imports')
export class AdifImportController {
  constructor(private readonly activity: ActivityService) {}

  @Post()
  @HttpCode(202)
  create(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: Record<string, any>,
  ) {
    return this.activity.createAdifImport(authorization, key, body);
  }

  @Get(':importId')
  get(
    @Headers('authorization') authorization: string | undefined,
    @Param('importId') id: string,
  ) {
    return this.activity.getAdifImport(authorization, id);
  }
}
