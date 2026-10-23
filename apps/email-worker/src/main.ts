import { NestFactory } from '@nestjs/core';
import { ObserveInstrument } from '@app/platform';
import { EmailWorkerModule } from './email-worker.module.js';

const app = await NestFactory.createApplicationContext(EmailWorkerModule, {
  logger: ['error', 'warn', 'log'],
  instrument: ObserveInstrument,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close());
}
