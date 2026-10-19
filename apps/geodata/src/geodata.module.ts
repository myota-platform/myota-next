import { Module } from '@nestjs/common';
import { DatabaseHealthModule, HealthController } from '@app/platform';

@Module({
  imports: [DatabaseHealthModule.forEnvironment('GEO_DATABASE_URL')],
  controllers: [HealthController],
})
export class GeodataModule {}
