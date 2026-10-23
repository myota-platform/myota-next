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
    @Body() body: Record<string, any>,
  ) {
    return this.activity.createAdifImport(authorization, body);
  }

  @Get(':importId')
  get(@Param('importId') id: string) {
    return this.activity.getAdifImport(id);
  }
}
