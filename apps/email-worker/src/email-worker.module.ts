import { Module } from '@nestjs/common';
import { DatabaseHealthModule } from '@app/platform';
import { EmailWorkerService } from './email-worker.service.js';

@Module({
  imports: [DatabaseHealthModule.forEnvironment('CORE_DATABASE_URL')],
  providers: [EmailWorkerService],
})
export class EmailWorkerModule {}
