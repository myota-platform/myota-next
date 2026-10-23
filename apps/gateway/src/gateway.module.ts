import { Module } from '@nestjs/common';
import { HealthController, observeRoot } from '@app/platform';
import { GatewayController } from './gateway.controller.js';

@Module({
  imports: [observeRoot('gateway')],
  controllers: [HealthController, GatewayController],
})
export class GatewayModule {}
