import { bootstrapHttpService } from '@app/platform';
import { integerSetting } from '@app/platform/integer-setting.js';
import { RequestMethod } from '@nestjs/common';
import { GeodataModule } from './geodata.module.js';

await bootstrapHttpService(
  GeodataModule,
  8003,
  integerSetting(process.env.MYOTA_MAX_BODY_BYTES, 1024 * 1024 * 1024),
  ['/v1/geodata/import-uploads/:uploadId/parts/:partNumber'],
  [{ path: 'metrics', method: RequestMethod.GET }],
  true,
);
