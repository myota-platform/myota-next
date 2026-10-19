import { bootstrapHttpService } from '@app/platform';
import { RequestMethod } from '@nestjs/common';
import { GatewayModule } from './gateway.module.js';

await bootstrapHttpService(
  GatewayModule,
  8080,
  '35mb',
  [],
  [
    { path: '_internal/grafana/auth', method: RequestMethod.GET },
    { path: 'metrics', method: RequestMethod.GET },
  ],
);
