import { NestFactory } from '@nestjs/core';
import { ObserveInstrument } from '@app/platform';
import { GeodataImporterModule } from './geodata-importer.module.js';

const app = await NestFactory.createApplicationContext(GeodataImporterModule, {
  logger: ['error', 'warn', 'log'],
  instrument: ObserveInstrument,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close());
}
