import { NestFactory } from '@nestjs/core';
import { ObserveInstrument } from '@app/platform';
import { OutboxWorkerModule } from './outbox-worker.module.js';

const app = await NestFactory.createApplicationContext(OutboxWorkerModule, {
  logger: ['error', 'warn', 'log'],
  instrument: ObserveInstrument,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close());
}
