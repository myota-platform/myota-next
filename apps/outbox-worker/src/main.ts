import { NestFactory } from '@nestjs/core';
import { OutboxWorkerModule } from './outbox-worker.module.js';

const app = await NestFactory.createApplicationContext(OutboxWorkerModule, {
  logger: ['error', 'warn', 'log'],
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close());
}
