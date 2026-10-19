import { NestFactory } from '@nestjs/core';
import { ActivityNotificationsModule } from './activity-notifications.module.js';

const app = await NestFactory.createApplicationContext(
  ActivityNotificationsModule,
  { logger: ['error', 'warn', 'log'] },
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close());
}
