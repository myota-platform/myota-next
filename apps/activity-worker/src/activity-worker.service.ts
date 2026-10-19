import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ActivityWorkRepository } from './activity-work.repository.js';

@Injectable()
export class ActivityWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ActivityWorkerService.name);
  private stopping = false;

  constructor(private readonly repository: ActivityWorkRepository) {}

  onModuleInit() {
    void this.run();
  }

  onModuleDestroy() {
    this.stopping = true;
  }

  private async run() {
    const pollMs = boundedInteger(
      process.env.MYOTA_WORKER_POLL_MS,
      1000,
      100,
      30000,
    );
    while (!this.stopping) {
      try {
        const job = await this.repository.claim();
        if (!job) {
          await delay(pollMs);
          continue;
        }
        const heartbeatMs = boundedInteger(
          process.env.MYOTA_WORKER_LEASE_HEARTBEAT_MS,
          40000,
          5000,
          60000,
        );
        let heartbeatRunning = false;
        const heartbeatTimer = setInterval(() => {
          if (heartbeatRunning) return;
          heartbeatRunning = true;
          void this.repository
            .heartbeat(job)
            .then((extended) => {
              if (!extended)
                this.logger.warn(`Activity job ${job.id} lease was lost`);
            })
            .catch((error: unknown) => {
              this.logger.warn(
                `Activity job ${job.id} lease heartbeat failed: ${error instanceof Error ? error.message : 'database error'}`,
              );
            })
            .finally(() => {
              heartbeatRunning = false;
            });
        }, heartbeatMs);
        heartbeatTimer.unref();
        try {
          await this.repository.process(job);
          this.logger.log(`Completed activity job ${job.id} (${job.kind})`);
        } catch (error) {
          this.logger.error(
            `Activity job ${job.id} failed`,
            error instanceof Error ? error.stack : undefined,
          );
          clearInterval(heartbeatTimer);
          await this.repository.retry(job, error);
        } finally {
          clearInterval(heartbeatTimer);
        }
      } catch (error) {
        this.logger.error(
          'Activity worker database poll failed',
          error instanceof Error ? error.stack : undefined,
        );
        await delay(pollMs);
      }
    }
  }
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
