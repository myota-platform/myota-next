import { Module } from '@nestjs/common';
import { DatabaseHealthModule, HealthController } from '@app/platform';
import { GeodataController } from './geodata.controller.js';
import { GeodataRepository } from './geodata.repository.js';
import { GeodataImportService } from './geodata-import.service.js';
import { GeodataMutationRepository } from './geodata-mutation.repository.js';

@Module({
  imports: [DatabaseHealthModule.forEnvironment('GEO_DATABASE_URL')],
  controllers: [HealthController, GeodataController],
  providers: [
    GeodataRepository,
    GeodataImportService,
    GeodataMutationRepository,
  ],
})
export class GeodataModule {}
