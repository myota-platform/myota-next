import {
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
import { ProgrammesService } from './programmes.service.js';
import { CreateProgrammeDto, UpdateProgrammeDto } from './programmes.dto.js';
import { firstQueryValue } from '@app/platform/query.js';

@Controller('programmes')
export class ProgrammesController {
  constructor(private readonly programmes: ProgrammesService) {}

  @Get()
  list(
    @Query()
    query: {
      page?: string | string[];
      pageSize?: string | string[];
    },
  ) {
    return this.programmes.list({
      page: firstQueryValue(query.page),
      pageSize: firstQueryValue(query.pageSize),
    });
  }

  @Post()
  @HttpCode(201)
  create(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: CreateProgrammeDto,
  ) {
    return this.programmes.create(authorization, body, idempotencyKey);
  }

  @Get(':slug/policy')
  getPolicy(@Param('slug') slug: string) {
    return this.programmes.getPolicy(slug);
  }

  @Patch(':slug')
  update(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('slug') slug: string,
    @Body() body: UpdateProgrammeDto,
  ) {
    return this.programmes.update(authorization, slug, body, idempotencyKey);
  }

  @Get(':slug')
  get(@Param('slug') slug: string) {
    return this.programmes.get(slug);
  }
}
