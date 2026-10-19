import { bootstrapHttpService } from '@app/platform';
import { GeodataModule } from './geodata.module.js';

await bootstrapHttpService(GeodataModule, 8003, '20mb', [
  '/v1/geodata/import-uploads/:uploadId/parts/:partNumber',
]);
