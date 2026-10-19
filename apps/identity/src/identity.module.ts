import { Module } from '@nestjs/common';
import { DatabaseHealthModule, HealthController } from '@app/platform';
import { AuthController } from './auth.controller.js';
import { IdentityAuthService } from './auth.service.js';
import { IdentityRoleService } from './identity-role.service.js';
import { IdentityAccountService } from './identity-account.service.js';
import { IdentityIntegrationService } from './identity-integration.service.js';
import { IdentityCredentialService } from './identity-credential.service.js';

@Module({
  imports: [DatabaseHealthModule.forEnvironment('CORE_DATABASE_URL')],
  controllers: [HealthController, AuthController],
  providers: [
    IdentityAuthService,
    IdentityRoleService,
    IdentityAccountService,
    IdentityIntegrationService,
    IdentityCredentialService,
  ],
})
export class IdentityModule {}
