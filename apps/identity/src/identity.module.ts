import { Module } from '@nestjs/common';
import { DatabaseHealthModule, HealthController } from '@app/platform';
import { AuthController } from './auth.controller.js';
import { IdentityAuthService } from './auth.service.js';
import { IdentityRoleService } from './identity-role.service.js';
import { IdentityAccountService } from './identity-account.service.js';

@Module({
  imports: [DatabaseHealthModule.forEnvironment('CORE_DATABASE_URL')],
  controllers: [HealthController, AuthController],
  providers: [IdentityAuthService, IdentityRoleService, IdentityAccountService],
})
export class IdentityModule {}
