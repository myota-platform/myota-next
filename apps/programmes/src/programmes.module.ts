import { Module } from '@nestjs/common';
import { DatabaseHealthModule, HealthController } from '@app/platform';

@Module({
  imports: [DatabaseHealthModule.forEnvironment('CORE_DATABASE_URL')],
  controllers: [HealthController],
})
export class ProgrammesModule {}
