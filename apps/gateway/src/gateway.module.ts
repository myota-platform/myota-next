import { Module } from '@nestjs/common';
import { HealthController } from '@app/platform';

@Module({
  controllers: [HealthController],
})
export class GatewayModule {}
