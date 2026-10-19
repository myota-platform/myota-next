import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { GeodataWorkRepository } from './geodata-work.repository.js';
import { GeodataPromotionRepository } from './geodata-promotion.repository.js';
import { GeodataEnrichmentRepository } from './geodata-enrichment.repository.js';

@Injectable()
export class GeodataWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GeodataWorkerService.name);
  private stopping = false;
  private promotionFirst = false;

  constructor(
    private readonly repository: GeodataWorkRepository,
    private readonly promotion: GeodataPromotionRepository,
    private readonly enrichment: GeodataEnrichmentRepository,
  ) {}

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
        this.promotionFirst = !this.promotionFirst;
        const worked = this.promotionFirst
          ? (await this.processPromotion()) ||
            (await this.processImport()) ||
            (await this.processEnrichment())
          : (await this.processImport()) ||
            (await this.processEnrichment()) ||
            (await this.processPromotion());
        if (!worked) await delay(pollMs);
      } catch (error) {
        this.logger.error(
          'Geodata worker database poll failed',
          error instanceof Error ? error.stack : undefined,
        );
        await delay(pollMs);
      }
    }
  }

  private async processImport() {
    const run = await this.repository.claim();
    if (!run) return false;
    try {
      await this.repository.preprocess(run);
      this.logger.log(`Preprocessed geodata import ${run.id}`);
    } catch (error) {
      if (await this.repository.fail(run, error))
        this.logger.log(`Cancelled geodata import ${run.id}`);
      else
        this.logger.error(
          `Geodata import ${run.id} failed`,
          error instanceof Error ? error.stack : undefined,
        );
    }
    return true;
  }

  private async processPromotion() {
    const queue = await this.promotion.claimPromotion();
    if (!queue) return false;
    try {
      await this.promotion.processPromotion(queue);
      this.logger.log(`Processed geodata promotion queue ${queue.id}`);
    } catch (error) {
      this.logger.error(
        `Geodata promotion queue ${queue.id} failed`,
        error instanceof Error ? error.stack : undefined,
      );
      await this.promotion.retryPromotion(queue, error);
    }
    return true;
  }

  private async processEnrichment() {
    const job = await this.enrichment.claim();
    if (!job) return false;
    try {
      await this.enrichment.process(job);
      this.logger.log(`Enriched geodata entity ${job.id}`);
    } catch (error) {
      this.logger.error(
        `Geodata location enrichment ${job.id} failed`,
        error instanceof Error ? error.stack : undefined,
      );
    }
    return true;
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
