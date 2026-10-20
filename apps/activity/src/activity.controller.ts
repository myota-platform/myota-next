import {
  BadRequestException,
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
import { firstQueryValue } from '@app/platform/query.js';
import { ActivityService } from './activity.service.js';

@Controller('activations')
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get('entity-deletion-impacts/:entityId')
  entityDeletionImpact(
    @Headers('authorization') authorization: string | undefined,
    @Param('entityId') entityId: string,
  ) {
    return this.activity.entityDeletionImpact(authorization, entityId);
  }

  @Post('entity-deletion-cascades')
  @HttpCode(200)
  cascadeDeleteEntity(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: Record<string, unknown> | null,
  ) {
    return this.activity.cascadeDeleteEntity(authorization, key, body ?? {});
  }

  @Get()
  list(
    @Headers('authorization') authorization: string | undefined,
    @Query()
    query: {
      programme?: string | string[];
      operatorId?: string | string[];
      page?: string | string[];
      pageSize?: string | string[];
    },
  ) {
    return this.activity.list(authorization, {
      programme: firstQueryValue(query.programme),
      operatorId: firstQueryValue(query.operatorId),
      page: firstQueryValue(query.page),
      pageSize: firstQueryValue(query.pageSize),
    });
  }

  @Post()
  create(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: Record<string, any>,
  ) {
    return this.activity.create(authorization, key, body);
  }

  @Get(':activationId')
  get(
    @Headers('authorization') authorization: string | undefined,
    @Param('activationId') id: string,
  ) {
    return this.activity.get(authorization, id);
  }

  @Post(':activationId/qsos')
  addQso(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('activationId') id: string,
    @Body() body: Record<string, any>,
  ) {
    return this.activity.addQso(authorization, key, id, body);
  }

  @Patch(':activationId')
  close(
    @Headers('authorization') authorization: string | undefined,
    @Param('activationId') id: string,
    @Body() body: Record<string, any> | null,
  ) {
    if (body?.status !== 'CLOSED')
      throw new BadRequestException(
        'the activation resource currently supports status=CLOSED only',
      );
    return this.activity.close(authorization, id, body ?? {});
  }
}
