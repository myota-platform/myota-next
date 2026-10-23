import { Module } from '@nestjs/common';
import { DatabaseHealthModule, observeRoot } from '@app/platform';
import { parseJsonWithFloatMetadata } from '@app/platform/json-exact.js';
import { ActivityNotificationsService } from './activity-notifications.service.js';

@Module({
  imports: [
    observeRoot('activity-notifications'),
    DatabaseHealthModule.forEnvironment(
      'ACTIVITY_DATABASE_URL',
      parseJsonWithFloatMetadata,
    ),
  ],
  providers: [ActivityNotificationsService],
})
export class ActivityNotificationsModule {}
