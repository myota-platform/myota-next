import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { IdentityMaintenanceRepository } from './identity-maintenance.repository.js';
import { integerSetting } from '@app/platform/integer-setting.js';
import { abortableDelay } from '@app/platform/async-timers.js';
import { retryTransientDatabaseOperation } from '@app/platform/database-retry.js';

const INTERVAL_SECONDS = integerSetting(
  process.env.MYOTA_IDENTITY_MAINTENANCE_SECONDS,
  3600,
);

@Injectable()
export class IdentityMaintenanceService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(IdentityMaintenanceService.name);
  private stopping = false;
  private readonly stopController = new AbortController();
  private loop?: Promise<void>;

  constructor(private readonly repository: IdentityMaintenanceRepository) {}

  onModuleInit(): void {
    if (!process.env.CORE_DATABASE_URL)
      throw new Error('CORE_DATABASE_URL is required');
    this.loop = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.stopController.abort();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        const result = await retryTransientDatabaseOperation(
          () => this.repository.runSweep(),
          {
            stopping: () => this.stopping,
            onRetry: (error, attempt) => {
              if (attempt === 1 || attempt % 12 === 0)
                this.logger.warn(
                  `Identity maintenance is waiting for PostgreSQL: ${safeError(error)}`,
                );
            },
            wait: (milliseconds) =>
              abortableDelay(milliseconds, this.stopController.signal),
          },
        );
        if (result.databaseRecordsRemoved || result.profileImagesRemoved)
          this.logger.log(
            `Identity maintenance completed: ${JSON.stringify(result)}`,
          );
      } catch (error) {
        if (this.stopping) return;
        this.logger.error(`Identity maintenance failed: ${safeError(error)}`);
        throw error;
      }
      if (INTERVAL_SECONDS < 0)
        throw new RangeError('sleep length must be non-negative');
      await abortableDelay(INTERVAL_SECONDS * 1000, this.stopController.signal);
    }
  }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 300);
}
