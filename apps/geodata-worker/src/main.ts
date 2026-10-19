import { NestFactory } from '@nestjs/core';
import { GeodataWorkerModule } from './geodata-worker.module.js';

const app = await NestFactory.createApplicationContext(GeodataWorkerModule, {
  logger: ['error', 'warn', 'log'],
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close());
}
