import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { ActivityService } from './activity.service.js';

@Controller('qsos/:qsoId/corrections')
export class QsoCorrectionController {
  constructor(private readonly activity: ActivityService) {}

  @Post()
  request(
    @Headers('authorization') authorization: string | undefined,
    @Param('qsoId') qsoId: string,
    @Body() body: Record<string, any>,
  ) {
    return this.activity.requestCorrection(authorization, qsoId, body);
  }

  @Post(':correctionId/review')
  @HttpCode(200)
  review(
    @Headers('authorization') authorization: string | undefined,
    @Param('qsoId') qsoId: string,
    @Param('correctionId') correctionId: string,
    @Body() body: Record<string, any>,
  ) {
    return this.activity.reviewCorrection(
      authorization,
      qsoId,
      correctionId,
      body,
    );
  }
}
