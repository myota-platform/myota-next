import { NestFactory } from '@nestjs/core';
import { GeodataImporterModule } from './geodata-importer.module.js';

const app = await NestFactory.createApplicationContext(GeodataImporterModule, {
  logger: ['error', 'warn', 'log'],
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close());
}
