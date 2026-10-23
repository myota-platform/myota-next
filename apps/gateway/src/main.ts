import { bootstrapHttpService } from '@app/platform';
import { integerSetting } from '@app/platform/integer-setting.js';
import { RequestMethod } from '@nestjs/common';
import { GatewayModule } from './gateway.module.js';

await bootstrapHttpService(
  GatewayModule,
  8080,
  integerSetting(process.env.MYOTA_MAX_BODY_BYTES, 1024 ** 3),
  [],
  [{ path: '_internal/grafana/auth', method: RequestMethod.GET }],
  false,
  'gateway',
  [],
  false,
);
