import { Module } from '@nestjs/common';
import { DatabaseHealthModule, observeRoot } from '@app/platform';
import { parseJsonWithExactIntegers } from '@app/platform/json-exact.js';
import { OutboxWorkerService } from './outbox-worker.service.js';

@Module({
  imports: [
    observeRoot('outbox-worker'),
    DatabaseHealthModule.forEnvironment(
      'OUTBOX_DATABASE_URL',
      parseJsonWithExactIntegers,
    ),
  ],
  providers: [OutboxWorkerService],
})
export class OutboxWorkerModule {}
