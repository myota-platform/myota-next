import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import type { Consumer, JsMsg } from '@nats-io/jetstream';
import { connect } from '@nats-io/transport-node';
import { loadOutboxRegistry } from '@app/platform/outbox-routing.js';
import { GeodataWorkRepository } from './geodata-work.repository.js';
import { GeodataPromotionRepository } from './geodata-promotion.repository.js';
import { GeodataEnrichmentRepository } from './geodata-enrichment.repository.js';
import { GeodataDeletionRepository } from './geodata-deletion.repository.js';
import { GeodataRetentionRepository } from './geodata-retention.repository.js';

const STREAM = 'MYOTA_GEODATA_WORK';
const MAX_DELIVERIES = Math.max(
  1,
  Number(process.env.GEODATA_WORKER_MAX_DELIVERIES ?? 100),
);
const MAX_WORK_WAIT_SECONDS = 30;
const WORK_RECONCILE_SECONDS = Math.max(
  5,
  Number(process.env.GEODATA_WORK_RECONCILE_SECONDS ?? 60),
);
const RETENTION_INTERVAL_SECONDS = Math.max(
  60,
  Number(process.env.GEODATA_IMPORT_RETENTION_INTERVAL_SECONDS ?? 86400),
);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type State = {
  status: string | null;
  leaseRemainingSeconds: number;
  requestId?: string | null;
};

type WorkDefinition = {
  workType: string;
  subject: string;
  durable: string;
  producers: string[];
  consumer: Consumer;
  extractId(envelope: Record<string, unknown>): string;
  claim(envelope: Record<string, unknown>): Promise<unknown>;
  getState(envelope: Record<string, unknown>): Promise<State | null>;
  process(job: any, message: JsMsg): Promise<void>;
  onFailure?(job: unknown, error: unknown): Promise<void>;
  heartbeat?(job: any): Promise<boolean>;
  ackWaitSeconds: number;
  maxPending: number;
  maxDeliveries: number;
};

@Injectable()
export class GeodataWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GeodataWorkerService.name);
  private stopping = false;
  private readonly stopSignal: Promise<void>;
  private resolveStop!: () => void;
  private connection?: Awaited<ReturnType<typeof connect>>;
  private loops: Promise<void>[] = [];
  private readonly repository: GeodataWorkRepository;
  private readonly promotion: GeodataPromotionRepository;
  private readonly enrichment: GeodataEnrichmentRepository;
  private readonly deletions: GeodataDeletionRepository;
  private readonly retention: GeodataRetentionRepository;

  constructor(
    repository: GeodataWorkRepository,
    promotion: GeodataPromotionRepository,
    enrichment: GeodataEnrichmentRepository,
    deletions: GeodataDeletionRepository,
    retention: GeodataRetentionRepository,
  ) {
    this.repository = repository;
    this.promotion = promotion;
    this.enrichment = enrichment;
    this.deletions = deletions;
    this.retention = retention;
    this.stopSignal = new Promise((resolve) => {
      this.resolveStop = resolve;
    });
  }

  async onModuleInit(): Promise<void> {
    if (!process.env.GEO_DATABASE_URL)
      throw new Error('GEO_DATABASE_URL is required');
    const registry = await loadOutboxRegistry();
    const work = registry.work.filter(
      (item) => item.owner === 'geodata-service',
    );
    if (work.length !== 4)
      throw new Error(
        'Geodata work registry must define four durable commands',
      );
    this.connection = await connect({
      servers: process.env.NATS_URL ?? 'nats://nats:4222',
      name: 'geodata-worker',
      timeout: 5000,
      reconnect: true,
      maxReconnectAttempts: -1,
    });
    try {
      const js = jetstream(this.connection);
      const manager = await jetstreamManager(this.connection);
      const definitions: WorkDefinition[] = [];
      for (const item of work) {
        const target = registry.targetWorkRoutes[item.workType];
        if (!target)
          throw new Error(`Missing registered route for ${item.workType}`);
        const info = await manager.consumers.info(STREAM, item.durable);
        const policy = workPolicy(item.durable);
        this.validateConsumer(item.durable, item.subject, policy, info.config);
        definitions.push({
          workType: item.workType,
          subject: item.subject,
          durable: item.durable,
          producers: target.producers,
          consumer: await js.consumers.get(STREAM, item.durable),
          extractId: (envelope) => workId(envelope),
          claim: (envelope) => this.claim(item.workType, envelope),
          getState: (envelope) => this.getState(item.workType, envelope),
          process: (job, message) => this.process(item.workType, job, message),
          onFailure: (job, error) => this.onFailure(item.workType, job, error),
          heartbeat: (job) => this.heartbeat(item.workType, job),
          ...policy,
        });
      }
      this.loops = [
        ...definitions.map((definition) => this.consume(definition)),
        this.reconcileCancellations(),
        this.reconcileExpiredWork(),
        this.runRetention(),
      ];
    } catch (error) {
      await this.connection.drain();
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.resolveStop();
    await Promise.allSettled(this.loops);
    await this.connection?.drain();
  }

  private validateConsumer(
    durable: string,
    subject: string,
    expected: Pick<
      WorkDefinition,
      'ackWaitSeconds' | 'maxPending' | 'maxDeliveries'
    >,
    config: {
      filter_subject?: string;
      ack_policy?: unknown;
      ack_wait?: number;
      max_deliver?: number;
      max_ack_pending?: number;
      max_waiting?: number;
      deliver_policy?: unknown;
      replay_policy?: unknown;
      deliver_subject?: string;
    },
  ): void {
    if (
      config.filter_subject !== subject ||
      String(config.ack_policy).toLowerCase() !== 'explicit' ||
      Number(config.ack_wait) !== expected.ackWaitSeconds * 1_000_000_000 ||
      config.max_deliver !== expected.maxDeliveries ||
      config.max_ack_pending !== expected.maxPending ||
      config.max_waiting !== expected.maxPending ||
      String(config.deliver_policy).toLowerCase() !== 'all' ||
      String(config.replay_policy).toLowerCase() !== 'instant' ||
      config.deliver_subject != null
    ) {
      throw new Error(
        `Geodata durable ${durable} does not match its registered pull policy`,
      );
    }
  }

  private async consume(definition: WorkDefinition): Promise<void> {
    while (!this.stopping) {
      try {
        const message = await definition.consumer.next({ expires: 1000 });
        if (message) await this.handle(definition, message);
      } catch (error) {
        if (!this.stopping) {
          this.logger.error(
            `Geodata durable ${definition.durable} poll failed: ${safeError(error)}`,
          );
          await pause(1000);
        }
      }
    }
  }

  private async handle(
    definition: WorkDefinition,
    message: JsMsg,
  ): Promise<void> {
    const delivery = Math.max(1, message.info.deliveryCount);
    let envelope: Record<string, unknown>;
    try {
      const decoded: unknown = JSON.parse(
        new TextDecoder().decode(message.data),
      );
      if (!isRecord(decoded)) throw new Error('invalid_envelope');
      envelope = decoded;
      validateEnvelope(definition, envelope, message.subject);
    } catch (error) {
      await this.deadLetter(
        definition,
        message,
        null,
        'invalid_envelope',
        error,
      );
      return;
    }

    let job: unknown = null;
    try {
      job = await this.claimUntilReady(definition, envelope, message);
      if (!job) return;
      await this.processWithHeartbeats(definition, job, message);
      message.ack();
      this.logger.log(
        `Completed Geodata work ${definition.workType} (${workId(envelope)})`,
      );
    } catch (error) {
      try {
        if (job && definition.onFailure) await definition.onFailure(job, error);
        const state = await definition.getState(envelope);
        if (isTerminal(definition.workType, state, envelope)) {
          message.ack();
          this.logger.warn(
            `Geodata work ${workId(envelope)} reached a terminal owner state: ${safeError(error)}`,
          );
          return;
        }
        if (delivery >= definition.maxDeliveries) {
          await this.deadLetter(
            definition,
            message,
            envelope,
            'delivery_attempts_exhausted',
            error,
          );
          return;
        }
        const retrySeconds = Math.min(
          60,
          Math.max(
            0,
            Number(process.env.GEODATA_WORKER_RETRY_DELAY_SECONDS ?? 5),
          ) * delivery,
        );
        message.nak(retrySeconds * 1000);
      } catch (persistError) {
        this.logger.error(
          `Could not persist Geodata work retry state: ${safeError(persistError)}`,
        );
      }
      this.logger.error(
        `Geodata work ${workId(envelope)} failed: ${safeError(error)}`,
      );
    }
  }

  private async claimUntilReady(
    definition: WorkDefinition,
    envelope: Record<string, unknown>,
    message: JsMsg,
  ): Promise<unknown> {
    const id = definition.extractId(envelope);
    while (!this.stopping) {
      const claimed = await definition.claim(envelope);
      if (claimed) return claimed;
      const state = await definition.getState(envelope);
      if (!state) {
        await this.deadLetter(
          definition,
          message,
          envelope,
          'work_row_missing',
          new Error('owning work row is missing'),
        );
        return null;
      }
      if (
        definition.workType === 'geodata.location-enrichment.v1' &&
        state.requestId !== id
      ) {
        message.ack();
        return null;
      }
      if (isTerminal(definition.workType, state, envelope)) {
        message.ack();
        return null;
      }
      const waitSeconds = Math.min(
        Math.max(state.leaseRemainingSeconds, 1),
        MAX_WORK_WAIT_SECONDS,
      );
      message.working();
      await this.wait(waitSeconds * 1000);
    }
    message.nak(1000);
    return null;
  }

  private async claim(
    workType: string,
    envelope: Record<string, unknown>,
  ): Promise<unknown> {
    const payload = envelope.payload as Record<string, unknown>;
    if (workType === 'geodata.import-preprocess.v1')
      return this.repository.claim(String(payload.importRunId));
    if (workType === 'geodata.import-promotion.v1')
      return this.promotion.claimPromotion(String(payload.queueId));
    if (workType === 'geodata.entity-delete.v1')
      return this.deletions.claim(String(payload.jobId));
    return this.enrichment.claim(
      String(payload.entityId),
      String(payload.requestId),
    );
  }

  private async getState(
    workType: string,
    envelope: Record<string, unknown>,
  ): Promise<State | null> {
    const payload = envelope.payload as Record<string, unknown>;
    if (workType === 'geodata.import-preprocess.v1')
      return this.repository.getRunState(String(payload.importRunId));
    if (workType === 'geodata.import-promotion.v1')
      return this.promotion.getPromotionState(String(payload.queueId));
    if (workType === 'geodata.entity-delete.v1')
      return this.deletions.getDeletionState(String(payload.jobId));
    return this.enrichment.getRequestState(String(payload.entityId));
  }

  private async process(
    workType: string,
    job: any,
    message: JsMsg,
  ): Promise<void> {
    if (workType === 'geodata.import-preprocess.v1') {
      await this.repository.preprocess(job);
      return;
    }
    if (workType === 'geodata.import-promotion.v1') {
      await this.promotion.processPromotion(job);
      return;
    }
    if (workType === 'geodata.location-enrichment.v1') {
      await this.enrichment.process(job);
      return;
    }
    if (!(await this.deletions.execute(job)))
      throw new Error('entity deletion cascade will be retried');
    void message;
  }

  private async onFailure(
    workType: string,
    job: any,
    error: unknown,
  ): Promise<void> {
    if (workType === 'geodata.import-preprocess.v1') {
      await this.repository.fail(job, error);
    } else if (workType === 'geodata.import-promotion.v1') {
      await this.promotion.retryPromotion(job, error);
    }
  }

  private async heartbeat(workType: string, job: any): Promise<boolean> {
    return workType === 'geodata.entity-delete.v1'
      ? this.deletions.heartbeat(job)
      : true;
  }

  private async processWithHeartbeats(
    definition: WorkDefinition,
    job: any,
    message: JsMsg,
  ): Promise<void> {
    const task = this.process(definition.workType, job, message);
    while (true) {
      const result = await Promise.race([
        task.then(() => 'done' as const),
        pause(30_000).then(() => 'tick' as const),
      ]);
      if (result === 'done') return;
      if (definition.heartbeat && !(await definition.heartbeat(job)))
        throw new Error('Geodata work lease was lost');
      message.working();
    }
  }

  private async deadLetter(
    definition: WorkDefinition,
    message: JsMsg,
    envelope: Record<string, unknown> | null,
    category: string,
    error: unknown,
  ): Promise<void> {
    const eventId =
      envelope &&
      typeof envelope.causationId === 'string' &&
      UUID.test(envelope.causationId)
        ? envelope.causationId
        : envelope &&
            typeof envelope.workId === 'string' &&
            UUID.test(envelope.workId)
          ? envelope.workId
          : messageIdFallback(message.subject, message.info.streamSequence);
    await this.repository.recordWorkDeadLetter(
      eventId,
      definition.workType,
      envelope ?? {},
      message.info.deliveryCount,
      error instanceof Error
        ? new Error(`${category}: ${error.message}`)
        : category,
    );
    message.term();
  }

  private async reconcileCancellations(): Promise<void> {
    while (!this.stopping) {
      try {
        const runIds = await this.repository.staleCancellationIds();
        for (const runId of runIds)
          await this.repository.finalizeStaleCancellation(runId);
      } catch (error) {
        this.logger.error(
          `Geodata cancellation reconciliation failed: ${safeError(error)}`,
        );
      }
      await this.wait(30_000);
    }
  }

  private async reconcileExpiredWork(): Promise<void> {
    while (!this.stopping) {
      try {
        const recovered = await this.repository.recoverExpiredWorkDispatches();
        if (Object.values(recovered).some((count) => count > 0))
          this.logger.warn(
            `Re-enqueued stale Geodata work: ${JSON.stringify(recovered)}`,
          );
      } catch (error) {
        this.logger.error(`Geodata work recovery failed: ${safeError(error)}`);
      }
      await this.wait(WORK_RECONCILE_SECONDS * 1000);
    }
  }

  private async runRetention(): Promise<void> {
    while (!this.stopping) {
      try {
        const result = await this.retention.purgeSweep();
        if (result.eligible || result.uploadsExpired)
          this.logger.log(
            `Geodata retention sweep completed: ${JSON.stringify(result)}`,
          );
      } catch (error) {
        this.logger.error(
          `Geodata retention sweep failed: ${safeError(error)}`,
        );
      }
      await this.wait(RETENTION_INTERVAL_SECONDS * 1000);
    }
  }

  private async wait(milliseconds: number): Promise<void> {
    await Promise.race([pause(milliseconds), this.stopSignal]);
  }
}

function workId(envelope: Record<string, unknown>): string {
  return typeof envelope.workId === 'string' ? envelope.workId : '';
}

function validateEnvelope(
  definition: WorkDefinition,
  envelope: Record<string, unknown>,
  subject: string,
): void {
  const payload = envelope.payload;
  const aggregate = envelope.aggregate;
  const allowed = new Set([
    'envelopeVersion',
    'workId',
    'workType',
    'createdAt',
    'producer',
    'causationId',
    'aggregate',
    'payload',
    'correlationId',
  ]);
  if (
    envelope.envelopeVersion !== 1 ||
    envelope.workType !== definition.workType ||
    typeof envelope.producer !== 'string' ||
    !definition.producers.includes(envelope.producer) ||
    typeof envelope.createdAt !== 'string' ||
    !envelope.createdAt.endsWith('Z') ||
    typeof envelope.causationId !== 'string' ||
    !UUID.test(envelope.causationId) ||
    typeof envelope.workId !== 'string' ||
    !UUID.test(envelope.workId) ||
    subject !== definition.subject ||
    !isRecord(aggregate) ||
    !isRecord(payload) ||
    Object.keys(envelope).some((key) => !allowed.has(key))
  )
    throw new Error('work_contract_mismatch');
  if (definition.workType === 'geodata.location-enrichment.v1') {
    if (
      Object.keys(payload).length !== 5 ||
      !isUuid(payload.entityId) ||
      payload.requestId !== envelope.workId ||
      !isUuid(payload.requestId) ||
      typeof payload.geometryHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(payload.geometryHash) ||
      typeof payload.onlyMissing !== 'boolean' ||
      typeof payload.reason !== 'string' ||
      payload.reason.length < 1 ||
      payload.reason.length > 80 ||
      aggregate.type !== 'entity' ||
      aggregate.id !== payload.entityId
    )
      throw new Error('location_work_contract_mismatch');
  } else {
    const field =
      definition.workType === 'geodata.import-preprocess.v1'
        ? 'importRunId'
        : definition.workType === 'geodata.import-promotion.v1'
          ? 'queueId'
          : 'jobId';
    const aggregateType =
      definition.workType === 'geodata.import-preprocess.v1'
        ? 'import_run'
        : definition.workType === 'geodata.import-promotion.v1'
          ? 'import_processing_queue'
          : 'entity_deletion_job';
    if (
      Object.keys(payload).length !== 1 ||
      payload[field] !== envelope.workId ||
      !isUuid(envelope.workId) ||
      aggregate.type !== aggregateType ||
      aggregate.id !== envelope.workId
    )
      throw new Error('work_payload_contract_mismatch');
  }
  if (
    envelope.correlationId !== undefined &&
    (typeof envelope.correlationId !== 'string' ||
      envelope.correlationId.length < 1 ||
      envelope.correlationId.length > 128 ||
      /[^\x21-\x7e]/.test(envelope.correlationId))
  )
    throw new Error('invalid_correlation_id');
}

function workPolicy(
  durable: string,
): Pick<WorkDefinition, 'ackWaitSeconds' | 'maxPending' | 'maxDeliveries'> {
  const policies: Record<string, [number, number, number]> = {
    'geodata-preprocessing-v1': [300, 1, MAX_DELIVERIES],
    'geodata-import-promotion-v1': [300, 1, MAX_DELIVERIES],
    'geodata-entity-deletion-v1': [120, 1, MAX_DELIVERIES],
    'geodata-location-enrichment-v1': [120, 4, 8],
  };
  const [ackWaitSeconds, maxPending, maxDeliveries] = policies[durable] ?? [];
  if (!ackWaitSeconds)
    throw new Error(`No Geodata policy registered for ${durable}`);
  return { ackWaitSeconds, maxPending, maxDeliveries };
}

function isTerminal(
  workType: string,
  state: State | null,
  envelope: Record<string, unknown>,
): boolean {
  if (!state) return false;
  if (
    workType === 'geodata.location-enrichment.v1' &&
    state.requestId !== envelope.workId
  )
    return true;
  return [
    'COMPLETED',
    'PREPROCESSED',
    'PREPROCESSED_WITH_ERRORS',
    'FAILED',
    'CANCELLED',
    'SUPERSEDED',
    'DELETED',
  ].includes(String(state.status).toUpperCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function messageIdFallback(subject: string, sequence: number): string {
  const hex = Buffer.from(`${subject}:${sequence}`)
    .toString('hex')
    .padEnd(32, '0')
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 300);
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
