import { Module } from '@nestjs/common';
import { DatabaseHealthModule } from '@app/platform';
import { ActivityWorkRepository } from './activity-work.repository.js';
import { ActivityWorkerService } from './activity-worker.service.js';

@Module({
  imports: [DatabaseHealthModule.forEnvironment('ACTIVITY_DATABASE_URL')],
  providers: [ActivityWorkRepository, ActivityWorkerService],
})
export class ActivityWorkerModule {}
