import { Module } from '@nestjs/common';
import { DatabaseHealthModule, observeRoot } from '@app/platform';
import { EmailWorkerService } from './email-worker.service.js';

@Module({
  imports: [
    observeRoot('email-worker'),
    DatabaseHealthModule.forEnvironment('CORE_DATABASE_URL'),
  ],
  providers: [EmailWorkerService],
})
export class EmailWorkerModule {}
