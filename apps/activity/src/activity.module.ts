import { Module } from '@nestjs/common';
import {
  DatabaseHealthModule,
  HealthController,
  HttpMetricsController,
  observeRoot,
} from '@app/platform';
import { parseJsonWithFloatMetadata } from '@app/platform/json-exact.js';
import { ActivityController } from './activity.controller.js';
import { ActivityRepository } from './activity.repository.js';
import { ActivityAwardsRepository } from './activity-awards.repository.js';
import { ActivityService } from './activity.service.js';
import { QsoIngestionController } from './qso-ingestion.controller.js';
import { PublicActivityController } from './public-activity.controller.js';
import { QsoCorrectionController } from './qso-correction.controller.js';
import { ActivityOperationsController } from './activity-operations.controller.js';
import { AwardsController } from './awards.controller.js';
import { AwardsService } from './awards.service.js';
import { AdifImportController } from './adif-import.controller.js';

@Module({
  imports: [
    observeRoot('activity-api'),
    DatabaseHealthModule.forEnvironment(
      'ACTIVITY_DATABASE_URL',
      parseJsonWithFloatMetadata,
    ),
  ],
  controllers: [
    HealthController,
    HttpMetricsController,
    ActivityController,
    QsoIngestionController,
    PublicActivityController,
    QsoCorrectionController,
    ActivityOperationsController,
    AwardsController,
    AdifImportController,
  ],
  providers: [
    ActivityRepository,
    ActivityAwardsRepository,
    ActivityService,
    AwardsService,
  ],
})
export class ActivityModule {}
