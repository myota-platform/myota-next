import { Module } from '@nestjs/common';
import { DatabaseHealthModule, HealthController } from '@app/platform';
import { ProgrammesController } from './programmes.controller.js';
import { ProgrammesService } from './programmes.service.js';

@Module({
  imports: [DatabaseHealthModule.forEnvironment('CORE_DATABASE_URL')],
  controllers: [HealthController, ProgrammesController],
  providers: [ProgrammesService],
})
export class ProgrammesModule {}
