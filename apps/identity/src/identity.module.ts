import { Module } from '@nestjs/common';
import {
  DatabaseHealthModule,
  HealthController,
  observeRoot,
} from '@app/platform';
import { AuthController } from './auth.controller.js';
import { IdentityAuthService } from './auth.service.js';
import { IdentityRoleService } from './identity-role.service.js';
import { IdentityAccountService } from './identity-account.service.js';
import { IdentityIntegrationService } from './identity-integration.service.js';
import { IdentityCredentialService } from './identity-credential.service.js';
import { IdentityProfileImageService } from './identity-profile-image.service.js';

@Module({
  imports: [
    observeRoot('identity-api'),
    DatabaseHealthModule.forEnvironment('CORE_DATABASE_URL'),
  ],
  controllers: [HealthController, AuthController],
  providers: [
    IdentityAuthService,
    IdentityRoleService,
    IdentityAccountService,
    IdentityIntegrationService,
    IdentityCredentialService,
    IdentityProfileImageService,
  ],
})
export class IdentityModule {}
