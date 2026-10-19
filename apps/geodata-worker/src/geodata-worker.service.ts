import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { GeodataWorkRepository } from './geodata-work.repository.js';

@Injectable()
export class GeodataWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GeodataWorkerService.name);
  private stopping = false;

  constructor(private readonly repository: GeodataWorkRepository) {}

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
        const run = await this.repository.claim();
        if (!run) {
          await delay(pollMs);
          continue;
        }
        try {
          await this.repository.preprocess(run);
          this.logger.log(`Preprocessed geodata import ${run.id}`);
        } catch (error) {
          this.logger.error(
            `Geodata import ${run.id} failed`,
            error instanceof Error ? error.stack : undefined,
          );
          await this.repository.fail(run, error);
        }
      } catch (error) {
        this.logger.error(
          'Geodata worker database poll failed',
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
  min: number,
  max: number,
) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
