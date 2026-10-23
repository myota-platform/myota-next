import { Module } from '@nestjs/common';
import { observeRoot } from '@app/platform';
import { GeodataImporterService } from './geodata-importer.service.js';

@Module({
  imports: [observeRoot('geodata-importer')],
  providers: [GeodataImporterService],
})
export class GeodataImporterModule {}
