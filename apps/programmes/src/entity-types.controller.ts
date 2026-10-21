import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Put,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { EntityTypeDto } from './programmes.dto.js';
import { ProgrammesService } from './programmes.service.js';

@Controller()
export class EntityTypesController {
  constructor(private readonly programmes: ProgrammesService) {}

  @Get('entity-types')
  list(@Headers('authorization') authorization: string | undefined) {
    return this.programmes.listEntityTypeCatalog(authorization);
  }

  @Post('entity-types')
  async save(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { statusCode, ...result } =
      await this.programmes.saveEntityTypeCatalog(
        authorization,
        body as unknown as EntityTypeDto,
        idempotencyKey,
      );
    response.status(statusCode);
    return result;
  }

  @Get('programmes/:slug/entity-types')
  listAssigned(
    @Headers('authorization') authorization: string | undefined,
    @Param('slug') slug: string,
  ) {
    return this.programmes.listProgrammeEntityTypes(authorization, slug);
  }

  @Post('programmes/:slug/entity-types')
  async saveAndAssign(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('slug') slug: string,
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { statusCode, ...result } =
      await this.programmes.saveAndAssignEntityType(
        authorization,
        slug,
        body as unknown as EntityTypeDto,
        idempotencyKey,
      );
    response.status(statusCode);
    return result;
  }

  @Put('programmes/:slug/entity-types/:categoryCode')
  assign(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('slug') slug: string,
    @Param('categoryCode') categoryCode: string,
  ) {
    return this.programmes.assignEntityType(
      authorization,
      slug,
      categoryCode,
      idempotencyKey,
    );
  }

  @Delete('programmes/:slug/entity-types/:categoryCode')
  unassign(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('slug') slug: string,
    @Param('categoryCode') categoryCode: string,
  ) {
    return this.programmes.unassignEntityType(
      authorization,
      slug,
      categoryCode,
      idempotencyKey,
    );
  }
}
