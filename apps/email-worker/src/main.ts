import { NestFactory } from '@nestjs/core';
import { EmailWorkerModule } from './email-worker.module.js';

const app = await NestFactory.createApplicationContext(EmailWorkerModule, {
  logger: ['error', 'warn', 'log'],
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close());
}
