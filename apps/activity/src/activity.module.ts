import { Module } from '@nestjs/common';
import { DatabaseHealthModule, HealthController } from '@app/platform';
import { ActivityController } from './activity.controller.js';
import { ActivityRepository } from './activity.repository.js';
import { ActivityService } from './activity.service.js';
import { QsoIngestionController } from './qso-ingestion.controller.js';
import { PublicActivityController } from './public-activity.controller.js';
import { QsoCorrectionController } from './qso-correction.controller.js';
import { ActivityOperationsController } from './activity-operations.controller.js';
import { AwardsController } from './awards.controller.js';
import { AwardsService } from './awards.service.js';
import { AdifImportController } from './adif-import.controller.js';

@Module({
  imports: [DatabaseHealthModule.forEnvironment('ACTIVITY_DATABASE_URL')],
  controllers: [
    HealthController,
    ActivityController,
    QsoIngestionController,
    PublicActivityController,
    QsoCorrectionController,
    ActivityOperationsController,
    AwardsController,
    AdifImportController,
  ],
  providers: [ActivityRepository, ActivityService, AwardsService],
})
export class ActivityModule {}
