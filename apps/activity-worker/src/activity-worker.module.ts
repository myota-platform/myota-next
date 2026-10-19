import { Module } from '@nestjs/common';
import { DatabaseHealthModule } from '@app/platform';
import { ActivityWorkRepository } from './activity-work.repository.js';
import { ActivityRetentionRepository } from './activity-retention.repository.js';
import { ActivityWorkerService } from './activity-worker.service.js';

@Module({
  imports: [DatabaseHealthModule.forEnvironment('ACTIVITY_DATABASE_URL')],
  providers: [
    ActivityWorkRepository,
    ActivityRetentionRepository,
    ActivityWorkerService,
  ],
})
export class ActivityWorkerModule {}
