import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { DatabaseHealthModule, observeRoot } from '@app/platform';
import { parseJsonWithFloatMetadata } from '@app/platform/json-exact.js';
import { ObserveEventBridge } from '@app/platform';
import { ActivityNotificationsController } from './activity-notifications.controller.js';
import { ActivityNotificationsService } from './activity-notifications.service.js';

@Module({
  imports: [
    observeRoot('activity-notifications'),
    DatabaseHealthModule.forEnvironment(
      'ACTIVITY_DATABASE_URL',
      parseJsonWithFloatMetadata,
    ),
  ],
  controllers: [ActivityNotificationsController],
  providers: [ActivityNotificationsService],
})
export class ActivityNotificationsModule {
  static withObserveTransport(transport: ObserveEventBridge): DynamicModule {
    return {
      module: ActivityNotificationsModule,
      providers: [{ provide: ObserveEventBridge, useValue: transport }],
    };
  }
}
