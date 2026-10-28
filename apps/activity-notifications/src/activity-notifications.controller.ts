import { Controller } from '@nestjs/common';
import { EventPattern } from '@nestjs/microservices';
import type { JsMsg } from '@nats-io/jetstream';
import { ActivityNotificationsService } from './activity-notifications.service.js';

const OBSERVE_PATTERN = 'myota.events.>';

@Controller()
export class ActivityNotificationsController {
  constructor(private readonly notifications: ActivityNotificationsService) {}

  @EventPattern(OBSERVE_PATTERN)
  handleMessage(message: JsMsg): Promise<void> {
    return this.notifications.handleObservedMessage(message);
  }
}
