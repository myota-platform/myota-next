import { Module } from '@nestjs/common';
import { GeodataImporterService } from './geodata-importer.service.js';

@Module({ providers: [GeodataImporterService] })
export class GeodataImporterModule {}
