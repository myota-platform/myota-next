import { Module } from '@nestjs/common';
import { HealthController } from '@app/platform';
import { GatewayController } from './gateway.controller.js';

@Module({
  controllers: [HealthController, GatewayController],
})
export class GatewayModule {}
