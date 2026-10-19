import { Module } from '@nestjs/common';
import { DatabaseHealthModule, HealthController } from '@app/platform';
import { ActivityController } from './activity.controller.js';
import { ActivityRepository } from './activity.repository.js';
import { ActivityService } from './activity.service.js';
import { QsoIngestionController } from './qso-ingestion.controller.js';
import { PublicActivityController } from './public-activity.controller.js';

@Module({
  imports: [DatabaseHealthModule.forEnvironment('ACTIVITY_DATABASE_URL')],
  controllers: [
    HealthController,
    ActivityController,
    QsoIngestionController,
    PublicActivityController,
  ],
  providers: [ActivityRepository, ActivityService],
})
export class ActivityModule {}
