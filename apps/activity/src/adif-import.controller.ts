import { Controller, Get, Headers, Param } from '@nestjs/common';
import { ActivityService } from './activity.service.js';

@Controller('adif/imports')
export class AdifImportController {
  constructor(private readonly activity: ActivityService) {}

  @Get(':importId')
  get(
    @Headers('authorization') authorization: string | undefined,
    @Param('importId') id: string,
  ) {
    return this.activity.getAdifImport(authorization, id);
  }
}
