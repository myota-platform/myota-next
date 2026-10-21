import { Injectable } from '@nestjs/common';
import { GeodataEntityReviewRepository } from './geodata-entity-review.repository.js';
import { GeodataEntityMetadataRepository } from './geodata-entity-metadata.repository.js';
import { GeodataEntityEnrichmentRequestRepository } from './geodata-entity-enrichment.repository.js';
import { GeodataEntityCategoryRepository } from './geodata-entity-categories.repository.js';
import { GeodataEntityGeometryRepository } from './geodata-entity-geometry.repository.js';

export { assertReviewCoverage } from './geodata-entity-mutation.helpers.js';

@Injectable()
export class GeodataEntityMutationRepository {
  constructor(
    private readonly review: GeodataEntityReviewRepository,
    private readonly metadata: GeodataEntityMetadataRepository,
    private readonly enrichment: GeodataEntityEnrichmentRequestRepository,
    private readonly categories: GeodataEntityCategoryRepository,
    private readonly geometry: GeodataEntityGeometryRepository,
  ) {}

  reviewEntity(
    ...args: Parameters<GeodataEntityReviewRepository['reviewEntity']>
  ) {
    return this.review.reviewEntity(...args);
  }

  patchEntityMetadata(
    ...args: Parameters<GeodataEntityMetadataRepository['patchEntityMetadata']>
  ) {
    return this.metadata.patchEntityMetadata(...args);
  }

  requestLocationEnrichment(
    ...args: Parameters<
      GeodataEntityEnrichmentRequestRepository['requestLocationEnrichment']
    >
  ) {
    return this.enrichment.requestLocationEnrichment(...args);
  }

  replaceEntityCategories(
    ...args: Parameters<
      GeodataEntityCategoryRepository['replaceEntityCategories']
    >
  ) {
    return this.categories.replaceEntityCategories(...args);
  }

  replaceEntityGeometry(
    ...args: Parameters<
      GeodataEntityGeometryRepository['replaceEntityGeometry']
    >
  ) {
    return this.geometry.replaceEntityGeometry(...args);
  }
}
