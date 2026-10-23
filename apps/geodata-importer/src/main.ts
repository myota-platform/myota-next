import { NestFactory } from '@nestjs/core';
import { ObserveInstrument } from '@app/platform';
import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import { GeodataImporterModule } from './geodata-importer.module.js';
import { GeodataImporterService } from './geodata-importer.service.js';

const app = await NestFactory.createApplicationContext(GeodataImporterModule, {
  logger:
    process.env.GEODATA_IMPORT_SPEC === undefined
      ? ['error', 'warn', 'log']
      : false,
  instrument: ObserveInstrument,
});

if (process.env.GEODATA_IMPORT_SPEC !== undefined) {
  const result = app.get(GeodataImporterService).getOneShotResult();
  process.stdout.write(`${stringifyJsonWithBigInts(result) ?? 'null'}\n`);
  await app.close();
} else {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void app.close());
  }
}
