import { randomUUID } from 'node:crypto';
import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import type { Consumer, JsMsg } from '@nats-io/jetstream';
import { connect } from '@nats-io/transport-node';
import type { Pool } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import {
  abortableDelay,
  waitForTaskOrTimeout,
} from '@app/platform/async-timers.js';
import { geodataConsumerPolicy } from '@app/platform/geodata-consumer-policy.js';
import { integerSetting } from '@app/platform/integer-setting.js';
import { IMPORT_RUN_HEARTBEAT_SECONDS } from '@app/platform/import-limits.js';
import { loadOutboxRegistry } from '@app/platform/outbox-routing.js';
import {
  WorkerProbeServer,
  workerProbePort,
} from '@app/platform/worker-probes.js';
import { pythonTruthy } from '@app/platform/python-truthiness.js';
import { GeodataWorkRepository } from './geodata-work.repository.js';
import { GeodataPromotionRepository } from './geodata-promotion.repository.js';
import { GeodataEnrichmentRepository } from './geodata-enrichment.repository.js';
import { GeodataDeletionRepository } from './geodata-deletion.repository.js';
import { GeodataRetentionRepository } from './geodata-retention.repository.js';

const STREAM = 'MYOTA_GEODATA_WORK';
const MAX_WORK_WAIT_SECONDS = 30;
const WORK_RECONCILE_SECONDS = Math.max(
  5,
  Number(process.env.GEODATA_WORK_RECONCILE_SECONDS ?? 60),
);
const CANCELLATION_RECONCILE_SECONDS = Math.max(
  5,
  integerSetting(process.env.GEODATA_CANCELLATION_RECONCILE_SECONDS, 30),
);
const RETENTION_INTERVAL_SECONDS = Math.max(
  60,
  Number(process.env.GEODATA_IMPORT_RETENTION_INTERVAL_SECONDS ?? 86400),
);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  heartbeatIntervalSeconds?: number;
  ackWaitSeconds: number;
  maxPending: number;
  maxDeliveries: number;
};

@Injectable()
export class GeodataWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GeodataWorkerService.name);
  private stopping = false;
  private readonly stopController = new AbortController();
  private connection?: Awaited<ReturnType<typeof connect>>;
  private loops: Promise<void>[] = [];
  private readonly probes = new WorkerProbeServer();
  private natsUp = false;
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
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {
    this.repository = repository;
    this.promotion = promotion;
    this.enrichment = enrichment;
    this.deletions = deletions;
    this.retention = retention;
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
          ...(item.workType === 'geodata.import-preprocess.v1'
            ? { heartbeatIntervalSeconds: IMPORT_RUN_HEARTBEAT_SECONDS }
            : {}),
          ...policy,
        });
      }
      this.natsUp = true;
      void this.monitorNats();
      await this.probes.listen(
        workerProbePort(
          process.env.GEODATA_WORKER_HEALTH_PORT,
          9113,
          'GEODATA_WORKER_HEALTH_PORT',
        ),
        async () => {
          if (this.stopping || !this.natsUp || !this.pool) return false;
          await this.pool.query('SELECT 1');
          return true;
        },
      );
      this.loops = [
        ...definitions.flatMap((definition) =>
          Array.from({ length: definition.maxPending }, () =>
            this.consume(definition),
          ),
        ),
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
    this.stopController.abort();
    await this.probes.close();
    await Promise.allSettled(this.loops);
    await this.connection?.drain();
  }

  private async monitorNats(): Promise<void> {
    try {
      for await (const status of this.connection!.status()) {
        if (status.type === 'disconnect' || status.type === 'reconnecting') {
          this.natsUp = false;
        } else if (status.type === 'reconnect') {
          this.natsUp = true;
        } else if (status.type === 'close') {
          this.natsUp = false;
          return;
        }
      }
    } catch (error) {
      this.natsUp = false;
      this.logger.warn(`NATS status monitor stopped: ${safeError(error)}`);
    }
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
          await abortableDelay(1000, this.stopController.signal);
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
      await this.deadLetter(message, null, 'invalid_envelope', error);
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
      this.extendMessageAck(message, 'waiting for Geodata work ownership');
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
    if (workType === 'geodata.import-preprocess.v1') {
      return this.repository.renewHeartbeat(job);
    }
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
    const databaseHeartbeatMs =
      (definition.heartbeatIntervalSeconds ?? 30) * 1000;
    const acknowledgementIntervalMs = Math.max(
      1000,
      (definition.ackWaitSeconds * 1000) / 3,
    );
    let lastDatabaseHeartbeat = Date.now();
    let lastAcknowledgement = Date.now();
    while (true) {
      const now = Date.now();
      const delay = Math.max(
        1,
        Math.min(
          databaseHeartbeatMs - (now - lastDatabaseHeartbeat),
          acknowledgementIntervalMs - (now - lastAcknowledgement),
        ),
      );
      if (await waitForTaskOrTimeout(task, delay)) return;
      const tickedAt = Date.now();
      if (tickedAt - lastDatabaseHeartbeat >= databaseHeartbeatMs) {
        let leaseHeld: boolean | undefined;
        try {
          leaseHeld = await definition.heartbeat?.(job);
        } catch (error) {
          this.logger.warn(
            `Geodata work heartbeat failed; processing continues: ${safeError(error)}`,
          );
        }
        if (leaseHeld === false) throw new Error('Geodata work lease was lost');
        lastDatabaseHeartbeat = tickedAt;
      }
      if (tickedAt - lastAcknowledgement >= acknowledgementIntervalMs) {
        this.extendMessageAck(message, 'processing Geodata work');
        lastAcknowledgement = tickedAt;
      }
    }
  }

  private extendMessageAck(message: JsMsg, context: string): void {
    try {
      message.working();
    } catch (error) {
      this.logger.warn(
        `Could not extend Geodata work ACK while ${context}: ${safeError(error)}`,
      );
    }
  }

  private async deadLetter(
    message: JsMsg,
    envelope: Record<string, unknown> | null,
    category: string,
    error: unknown,
  ): Promise<void> {
    const suppliedId = pythonTruthy(envelope?.causationId)
      ? envelope?.causationId
      : pythonTruthy(envelope?.workId)
        ? envelope?.workId
        : pythonTruthy(envelope?.eventId)
          ? envelope?.eventId
          : 'unknown';
    const eventId =
      typeof suppliedId === 'string' && isPythonUuid(suppliedId)
        ? suppliedId
        : randomUUID();
    const suppliedType = pythonTruthy(envelope?.workType)
      ? envelope?.workType
      : pythonTruthy(envelope?.eventType)
        ? envelope?.eventType
        : 'unknown';
    await this.repository.recordWorkDeadLetter(
      eventId,
      String(suppliedType),
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
      await this.wait(CANCELLATION_RECONCILE_SECONDS * 1000);
    }
  }

  private async reconcileExpiredWork(): Promise<void> {
    while (!this.stopping) {
      try {
        const recovered = await this.repository.recoverExpiredWorkDispatches();
        if (Object.values(recovered).some((count) => count > 0))
          this.logger.warn(
            `Re-enqueued stale Geodata work: ${stringifyJsonWithBigInts(recovered)}`,
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
            `Geodata retention sweep completed: ${stringifyJsonWithBigInts(result)}`,
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
    await abortableDelay(milliseconds, this.stopController.signal);
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
    typeof envelope.workId !== 'string' ||
    !UUID.test(envelope.workId) ||
    subject !== definition.subject ||
    !isRecord(aggregate) ||
    !isRecord(payload) ||
    Object.keys(envelope).some((key) => !allowed.has(key))
  )
    throw new Error('work_contract_mismatch');
  if (
    envelope.causationId !== undefined &&
    (typeof envelope.causationId !== 'string' ||
      envelope.causationId.length > 200)
  )
    throw new Error('invalid_causation_id');
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
  return geodataConsumerPolicy(durable);
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

function isPythonUuid(value: string): boolean {
  const hex = value
    .replaceAll('urn:', '')
    .replaceAll('uuid:', '')
    .replace(/^[{}]+|[{}]+$/g, '')
    .replaceAll('-', '');
  return /^[0-9a-f]{32}$/i.test(hex);
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 300);
}
