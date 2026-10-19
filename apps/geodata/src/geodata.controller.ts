import { Controller, Get, Param, Query } from '@nestjs/common';
import { GeodataRepository } from './geodata.repository.js';

@Controller('geodata')
export class GeodataController {
  constructor(private readonly repository: GeodataRepository) {}

  @Get('entities')
  listEntities(@Query() query: Record<string, unknown>) {
    return this.repository.listEntities(query);
  }

  @Get('entities/:entityId')
  getEntity(@Param('entityId') id: string) {
    return this.repository.getEntity(id);
  }
}
