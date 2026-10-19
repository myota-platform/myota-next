import { Module } from '@nestjs/common';
import { DatabaseHealthModule } from '@app/platform';
import { OutboxWorkerService } from './outbox-worker.service.js';

@Module({
  imports: [DatabaseHealthModule.forEnvironment('OUTBOX_DATABASE_URL')],
  providers: [OutboxWorkerService],
})
export class OutboxWorkerModule {}
