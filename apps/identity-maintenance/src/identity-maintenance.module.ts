import { Module } from '@nestjs/common';
import { DatabaseHealthModule } from '@app/platform';
import { IdentityMaintenanceRepository } from './identity-maintenance.repository.js';
import { IdentityMaintenanceService } from './identity-maintenance.service.js';

@Module({
  imports: [DatabaseHealthModule.forEnvironment('CORE_DATABASE_URL')],
  providers: [IdentityMaintenanceRepository, IdentityMaintenanceService],
})
export class IdentityMaintenanceModule {}
