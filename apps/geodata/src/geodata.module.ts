import { Module } from '@nestjs/common';
import {
  DatabaseHealthModule,
  HealthController,
  observeRoot,
} from '@app/platform';
import { GeodataController } from './geodata.controller.js';
import { GeodataImportsController } from './geodata-imports.controller.js';
import { GeodataOperationsController } from './geodata-operations.controller.js';
import { GeodataRepository } from './geodata.repository.js';
import { GeodataImportService } from './geodata-import.service.js';
import { GeodataImportMutationRepository } from './geodata-import-mutation.repository.js';
import { GeodataEntityMutationRepository } from './geodata-entity-mutation.repository.js';
import { GeodataEntityCreationRepository } from './geodata-entity-creation.repository.js';
import { GeodataEntityMutationSupport } from './geodata-entity-mutation-support.js';
import { GeodataEntityReviewRepository } from './geodata-entity-review.repository.js';
import { GeodataEntityMetadataRepository } from './geodata-entity-metadata.repository.js';
import { GeodataEntityEnrichmentRequestRepository } from './geodata-entity-enrichment.repository.js';
import { GeodataEntityCategoryRepository } from './geodata-entity-categories.repository.js';
import { GeodataEntityGeometryRepository } from './geodata-entity-geometry.repository.js';
import { GeodataUploadService } from './geodata-upload.service.js';
import { GeodataDeletionService } from './geodata-deletion.service.js';
import { GeodataScheduleService } from './geodata-schedule.service.js';
import { GeodataProposalService } from './geodata-proposal.service.js';
import { GeodataLoadTestCleanupService } from './geodata-load-test-cleanup.service.js';
import { GeodataMetricsController } from './geodata-metrics.controller.js';
import { GeodataQueryMetrics } from './geodata-query-metrics.service.js';
import { GeodataPromotionRepository } from '../../geodata-worker/src/geodata-promotion.repository.js';
import { GeodataPromotionScoring } from '../../geodata-worker/src/geodata-promotion-scoring.js';
import { parseJsonWithExactIntegers } from '@app/platform/json-exact.js';

@Module({
  imports: [
    observeRoot('geodata-api'),
    DatabaseHealthModule.forEnvironment(
      'GEO_DATABASE_URL',
      parseJsonWithExactIntegers,
    ),
  ],
  controllers: [
    HealthController,
    GeodataController,
    GeodataImportsController,
    GeodataOperationsController,
    GeodataMetricsController,
  ],
  providers: [
    GeodataRepository,
    GeodataImportService,
    GeodataImportMutationRepository,
    GeodataEntityMutationSupport,
    GeodataEntityReviewRepository,
    GeodataEntityMetadataRepository,
    GeodataEntityEnrichmentRequestRepository,
    GeodataEntityCategoryRepository,
    GeodataEntityGeometryRepository,
    GeodataEntityMutationRepository,
    GeodataEntityCreationRepository,
    GeodataUploadService,
    GeodataDeletionService,
    GeodataScheduleService,
    GeodataProposalService,
    GeodataLoadTestCleanupService,
    GeodataQueryMetrics,
    GeodataPromotionRepository,
    GeodataPromotionScoring,
  ],
})
export class GeodataModule {}
