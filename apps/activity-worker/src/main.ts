import { NestFactory } from '@nestjs/core';
import { ActivityWorkerModule } from './activity-worker.module.js';

const app = await NestFactory.createApplicationContext(ActivityWorkerModule, {
  logger: ['error', 'warn', 'log'],
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close());
}
