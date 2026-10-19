import { Module } from '@nestjs/common';
import { DatabaseHealthModule, HealthController } from '@app/platform';
import { AuthController } from './auth.controller.js';
import { IdentityAuthService } from './auth.service.js';

@Module({
  imports: [DatabaseHealthModule.forEnvironment('CORE_DATABASE_URL')],
  controllers: [HealthController, AuthController],
  providers: [IdentityAuthService],
})
export class IdentityModule {}
