import { Module } from '@nestjs/common';
import { DatabaseHealthModule } from '@app/platform';
import { GeodataWorkRepository } from './geodata-work.repository.js';
import { GeodataPromotionRepository } from './geodata-promotion.repository.js';
import { GeodataWorkerService } from './geodata-worker.service.js';

@Module({
  imports: [DatabaseHealthModule.forEnvironment('GEO_DATABASE_URL')],
  providers: [
    GeodataWorkRepository,
    GeodataPromotionRepository,
    GeodataWorkerService,
  ],
})
export class GeodataWorkerModule {}
