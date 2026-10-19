import { Module } from '@nestjs/common';
import { DatabaseHealthModule } from '@app/platform';
import { ActivityNotificationsService } from './activity-notifications.service.js';

@Module({
  imports: [DatabaseHealthModule.forEnvironment('ACTIVITY_DATABASE_URL')],
  providers: [ActivityNotificationsService],
})
export class ActivityNotificationsModule {}
