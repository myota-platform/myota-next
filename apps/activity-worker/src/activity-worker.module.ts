import { Module } from '@nestjs/common';
import { DatabaseHealthModule, observeRoot } from '@app/platform';
import { parseJsonWithFloatMetadata } from '@app/platform/json-exact.js';
import { ActivityWorkRepository } from './activity-work.repository.js';
import { ActivityRetentionRepository } from './activity-retention.repository.js';
import { ActivityWorkerService } from './activity-worker.service.js';

@Module({
  imports: [
    observeRoot('activity-worker'),
    DatabaseHealthModule.forEnvironment(
      'ACTIVITY_DATABASE_URL',
      parseJsonWithFloatMetadata,
    ),
  ],
  providers: [
    ActivityWorkRepository,
    ActivityRetentionRepository,
    ActivityWorkerService,
  ],
})
export class ActivityWorkerModule {}
