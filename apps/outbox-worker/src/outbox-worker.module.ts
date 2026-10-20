import { Module } from '@nestjs/common';
import { DatabaseHealthModule, observeRoot } from '@app/platform';
import { OutboxWorkerService } from './outbox-worker.service.js';

@Module({
  imports: [
    observeRoot('outbox-worker'),
    DatabaseHealthModule.forEnvironment('OUTBOX_DATABASE_URL'),
  ],
  providers: [OutboxWorkerService],
})
export class OutboxWorkerModule {}
