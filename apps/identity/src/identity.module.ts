import { Module } from '@nestjs/common';
import {
  DatabaseHealthModule,
  HealthController,
  HttpMetricsController,
  observeRoot,
} from '@app/platform';
import { AuthController } from './auth.controller.js';
import { IdentityAuthService } from './auth.service.js';
import { IdentityRoleService } from './identity-role.service.js';
import { IdentityAccountService } from './identity-account.service.js';
import { IdentityCallsignService } from './identity-callsign.service.js';
import { IdentityIntegrationService } from './identity-integration.service.js';
import { IdentityCredentialService } from './identity-credential.service.js';
import { IdentityProfileImageService } from './identity-profile-image.service.js';
import { IdentityBootstrapService } from './identity-bootstrap.service.js';
import { IdentityRegistrationService } from './identity-registration.service.js';

@Module({
  imports: [
    observeRoot('identity-api'),
    DatabaseHealthModule.forEnvironment('CORE_DATABASE_URL'),
  ],
  controllers: [HealthController, HttpMetricsController, AuthController],
  providers: [
    IdentityAuthService,
    IdentityRoleService,
    IdentityAccountService,
    IdentityCallsignService,
    IdentityIntegrationService,
    IdentityCredentialService,
    IdentityProfileImageService,
    IdentityBootstrapService,
    IdentityRegistrationService,
  ],
})
export class IdentityModule {}
