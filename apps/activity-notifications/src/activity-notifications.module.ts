import { Module } from '@nestjs/common';
import { DatabaseHealthModule, observeRoot } from '@app/platform';
import { ActivityNotificationsService } from './activity-notifications.service.js';

@Module({
  imports: [
    observeRoot('activity-notifications'),
    DatabaseHealthModule.forEnvironment('ACTIVITY_DATABASE_URL'),
  ],
  providers: [ActivityNotificationsService],
})
export class ActivityNotificationsModule {}
