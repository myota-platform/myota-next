import { Module } from '@nestjs/common';
import {
  DatabaseHealthModule,
  HealthController,
  observeRoot,
} from '@app/platform';
import { ProgrammesController } from './programmes.controller.js';
import { EntityTypesController } from './entity-types.controller.js';
import { ProgrammesService } from './programmes.service.js';
import { ProgrammeReadRepository } from './programme-read.repository.js';
import { ProgrammeContentRepository } from './programme-content.repository.js';
import { ProgrammePolicyRepository } from './programme-policy.repository.js';
import { ProgrammeMutationRepository } from './programme-mutation.repository.js';
import { ProgrammeRepository } from './programme.repository.js';
import { ProgrammeEntityTypeRepository } from './programme-entity-type.repository.js';
import { ProgrammeContentController } from './programme-content.controller.js';
import { ProgrammeContentService } from './programme-content.service.js';
import { ProgrammePolicyController } from './programme-policy.controller.js';
import { ProgrammePolicyService } from './programme-policy.service.js';

@Module({
  imports: [
    observeRoot('programmes-api'),
    DatabaseHealthModule.forEnvironment('CORE_DATABASE_URL'),
  ],
  controllers: [
    HealthController,
    ProgrammesController,
    EntityTypesController,
    ProgrammeContentController,
    ProgrammePolicyController,
  ],
  providers: [
    ProgrammesService,
    ProgrammeReadRepository,
    ProgrammeContentRepository,
    ProgrammePolicyRepository,
    ProgrammeMutationRepository,
    ProgrammeRepository,
    ProgrammeEntityTypeRepository,
    ProgrammeContentService,
    ProgrammePolicyService,
  ],
})
export class ProgrammesModule {}
