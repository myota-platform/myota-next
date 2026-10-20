import { NestFactory } from '@nestjs/core';
import { ObserveInstrument } from '@app/platform';
import { ActivityWorkerModule } from './activity-worker.module.js';

const app = await NestFactory.createApplicationContext(ActivityWorkerModule, {
  logger: ['error', 'warn', 'log'],
  instrument: ObserveInstrument,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close());
}
