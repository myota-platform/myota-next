import { Module } from '@nestjs/common';
import { DatabaseHealthModule, observeRoot } from '@app/platform';
import { GeodataWorkRepository } from './geodata-work.repository.js';
import { GeodataPromotionRepository } from './geodata-promotion.repository.js';
import { GeodataEnrichmentRepository } from './geodata-enrichment.repository.js';
import { GeodataDeletionRepository } from './geodata-deletion.repository.js';
import { GeodataRetentionRepository } from './geodata-retention.repository.js';
import { GeodataWorkerService } from './geodata-worker.service.js';

@Module({
  imports: [
    observeRoot('geodata-worker'),
    DatabaseHealthModule.forEnvironment('GEO_DATABASE_URL'),
  ],
  providers: [
    GeodataWorkRepository,
    GeodataPromotionRepository,
    GeodataEnrichmentRepository,
    GeodataDeletionRepository,
    GeodataRetentionRepository,
    GeodataWorkerService,
  ],
})
export class GeodataWorkerModule {}
