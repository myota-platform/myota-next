import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
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
  cascadeDeleteEntity(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    return this.activity.cascadeDeleteEntity(authorization, key, body);
  }

  @Get()
  list(
    @Headers('authorization') authorization: string | undefined,
    @Query()
    query: {
      programme?: string;
      operatorId?: string;
      page?: string;
      pageSize?: string;
    },
  ) {
    return this.activity.list(authorization, query);
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
    @Headers('idempotency-key') key: string | undefined,
    @Param('activationId') id: string,
    @Body() body: Record<string, any>,
  ) {
    if (body.status !== undefined && body.status !== 'CLOSED')
      throw new BadRequestException('only status CLOSED is supported');
    return this.activity.close(authorization, key, id, body);
  }
}
