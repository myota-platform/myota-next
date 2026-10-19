import { Module } from '@nestjs/common';
import { DatabaseHealthModule, HealthController } from '@app/platform';
import { GeodataController } from './geodata.controller.js';
import { GeodataRepository } from './geodata.repository.js';
import { GeodataImportService } from './geodata-import.service.js';
import { GeodataImportMutationRepository } from './geodata-import-mutation.repository.js';
import { GeodataEntityMutationRepository } from './geodata-entity-mutation.repository.js';
import { GeodataUploadService } from './geodata-upload.service.js';
import { GeodataDeletionService } from './geodata-deletion.service.js';
import { GeodataScheduleService } from './geodata-schedule.service.js';
import { GeodataProposalService } from './geodata-proposal.service.js';
import { GeodataLoadTestCleanupService } from './geodata-load-test-cleanup.service.js';

@Module({
  imports: [DatabaseHealthModule.forEnvironment('GEO_DATABASE_URL')],
  controllers: [HealthController, GeodataController],
  providers: [
    GeodataRepository,
    GeodataImportService,
    GeodataImportMutationRepository,
    GeodataEntityMutationRepository,
    GeodataUploadService,
    GeodataDeletionService,
    GeodataScheduleService,
    GeodataProposalService,
    GeodataLoadTestCleanupService,
  ],
})
export class GeodataModule {}
