import { Module } from '@nestjs/common';
import { DatabaseHealthModule, HealthController } from '@app/platform';
import { ActivityController } from './activity.controller.js';
import { ActivityRepository } from './activity.repository.js';
import { ActivityService } from './activity.service.js';
import { QsoIngestionController } from './qso-ingestion.controller.js';

@Module({
  imports: [DatabaseHealthModule.forEnvironment('ACTIVITY_DATABASE_URL')],
  controllers: [HealthController, ActivityController, QsoIngestionController],
  providers: [ActivityRepository, ActivityService],
})
export class ActivityModule {}
