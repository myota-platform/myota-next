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
  WorkerProbeServer,
  workerProbePort,
} from '@app/platform/worker-probes.js';
import { loadOutboxRegistry } from '@app/platform/outbox-routing.js';
import { integerSetting } from '@app/platform/integer-setting.js';
import {
  ActivityWorkRepository,
  type ClaimedJob,
} from './activity-work.repository.js';
import { ActivityRetentionRepository } from './activity-retention.repository.js';

const STREAM = 'MYOTA_ACTIVITY_WORK';
const MAX_DELIVERIES = 8;
const LEASE_SECONDS = 120;
const MAX_WORK_WAIT_SECONDS = 30;
const RETENTION_INTERVAL_SECONDS = Math.max(
  60,
  integerSetting(process.env.MYOTA_ADIF_RETENTION_INTERVAL_SECONDS, 86400),
);
const WORK_RECONCILE_SECONDS = Math.max(
  5,
  Number(process.env.ACTIVITY_WORK_RECONCILE_SECONDS ?? 60),
);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type WorkDefinition = {
  kind: string;
  workType: string;
  subject: string;
  durable: string;
  consumer: Consumer;
};

@Injectable()
export class ActivityWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ActivityWorkerService.name);
  private stopping = false;
  private readonly stopSignal: Promise<void>;
  private resolveStop!: () => void;
  private connection?: Awaited<ReturnType<typeof connect>>;
  private loops: Promise<void>[] = [];
  private readonly probes = new WorkerProbeServer();
  private natsUp = false;

  constructor(
    private readonly repository: ActivityWorkRepository,
    private readonly retention: ActivityRetentionRepository,
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {
    this.stopSignal = new Promise((resolve) => {
      this.resolveStop = resolve;
    });
  }

  async onModuleInit(): Promise<void> {
    if (!process.env.ACTIVITY_DATABASE_URL)
      throw new Error('ACTIVITY_DATABASE_URL is required');
    const registry = await loadOutboxRegistry();
    const work = registry.work.filter(
      (item) => item.owner === 'activity-service',
    );
    if (work.length !== 6) {
      throw new Error(
        'Activity work registry must define six durable commands',
      );
    }
    this.connection = await connect({
      servers: process.env.NATS_URL ?? 'nats://nats:4222',
      name: 'activity-worker',
      timeout: 5000,
      reconnect: true,
      maxReconnectAttempts: -1,
    });
    try {
      const js = jetstream(this.connection);
      const manager = await jetstreamManager(this.connection);
      const definitions: WorkDefinition[] = [];
      for (const item of work) {
        const info = await manager.consumers.info(STREAM, item.durable);
        this.validateConsumer(item.durable, item.subject, info.config);
        definitions.push({
          kind: kindFromWorkType(item.workType),
          workType: item.workType,
          subject: item.subject,
          durable: item.durable,
          consumer: await js.consumers.get(STREAM, item.durable),
        });
      }
      this.natsUp = true;
      void this.monitorNats();
      await this.probes.listen(
        workerProbePort(
          process.env.ACTIVITY_WORKER_HEALTH_PORT,
          9112,
          'ACTIVITY_WORKER_HEALTH_PORT',
        ),
        async () => {
          if (this.stopping || !this.natsUp || !this.pool) return false;
          await this.pool.query('SELECT 1');
          return true;
        },
      );
      this.loops = [
        ...definitions.map((definition) => this.consume(definition)),
        this.reconcileQueuedOutbox(),
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
    const expected = consumerPolicy(durable);
    if (
      config.filter_subject !== subject ||
      String(config.ack_policy).toLowerCase() !== 'explicit' ||
      Number(config.ack_wait) !== expected.ackWaitSeconds * 1_000_000_000 ||
      config.max_deliver !== MAX_DELIVERIES ||
      config.max_ack_pending !== expected.maxAckPending ||
      config.max_waiting !== expected.maxWaiting ||
      String(config.deliver_policy).toLowerCase() !== 'all' ||
      String(config.replay_policy).toLowerCase() !== 'instant' ||
      config.deliver_subject != null
    ) {
      throw new Error(
        `Activity work durable ${durable} does not match its registered pull policy`,
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
            `Activity durable ${definition.durable} poll failed: ${safeError(error)}`,
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
      try {
        await this.repository.recordWorkDeadLetter(
          message.subject,
          null,
          definition.workType,
          delivery,
          'invalid_envelope',
        );
        message.term();
      } catch (persistError) {
        this.logger.error(
          `Could not persist invalid Activity work delivery: ${safeError(persistError)}`,
        );
      }
      this.logger.error(
        `Invalid ${definition.durable} message: ${safeError(error)}`,
      );
      return;
    }

    const workId = envelope.workId as string;
    let job: ClaimedJob | null = null;
    try {
      job = await this.claimUntilReady(definition, message, workId, delivery);
      if (!job) return;
      await this.processWithHeartbeats(job, message);
      message.ack();
      this.logger.log(`Completed Activity work ${workId} (${definition.kind})`);
    } catch (error) {
      const delaySeconds = Math.min(300, 2 ** Math.min(delivery, 8));
      try {
        if (!job) {
          message.nak(delaySeconds * 1000);
        } else if (delivery >= MAX_DELIVERIES) {
          await this.repository.failWorkJob(
            job,
            error,
            message.subject,
            definition.workType,
            delivery,
          );
          message.ack();
        } else {
          await this.repository.retryWorkJob(job, error, delaySeconds);
          message.nak(delaySeconds * 1000);
        }
      } catch (persistError) {
        this.logger.error(
          `Could not persist Activity work retry state: ${safeError(persistError)}`,
        );
      }
      this.logger.error(
        `Activity work ${workId} (${definition.kind}) failed: ${safeError(error)}`,
      );
    }
  }

  private async claimUntilReady(
    definition: WorkDefinition,
    message: JsMsg,
    workId: string,
    delivery: number,
  ): Promise<ClaimedJob | null> {
    while (!this.stopping) {
      const job = await this.repository.claimWorkJob(
        workId,
        definition.kind,
        LEASE_SECONDS,
      );
      if (job) return job;
      const state = await this.repository.getWorkJobState(workId);
      if (!state) {
        await this.repository.recordWorkDeadLetter(
          message.subject,
          workId,
          definition.workType,
          delivery,
          'job_row_missing',
        );
        message.term();
        return null;
      }
      if (state.kind !== definition.kind) {
        await this.repository.recordWorkDeadLetter(
          message.subject,
          workId,
          definition.workType,
          delivery,
          'job_kind_mismatch',
        );
        message.term();
        return null;
      }
      if (state.status === 'SUCCEEDED' || state.status === 'FAILED') {
        message.ack();
        return null;
      }
      const remaining =
        state.status === 'QUEUED'
          ? state.retryAfterSeconds
          : state.leaseRemainingSeconds;
      const seconds = Math.min(
        Math.max(remaining, 0.25),
        MAX_WORK_WAIT_SECONDS,
      );
      message.working();
      await this.wait(seconds * 1000);
    }
    message.nak(1000);
    return null;
  }

  private async processWithHeartbeats(
    job: ClaimedJob,
    message: JsMsg,
  ): Promise<void> {
    const task = this.repository.process(job);
    while (true) {
      const state = await Promise.race([
        task.then(() => 'done' as const),
        pause(30_000).then(() => 'tick' as const),
      ]);
      if (state === 'done') return;
      const extended = await this.repository.heartbeat(job);
      if (!extended) throw new Error('worker lease was lost while processing');
      message.working();
    }
  }

  private async runRetention(): Promise<void> {
    while (!this.stopping) {
      try {
        const deleted = await this.retention.runSweep();
        if (deleted)
          this.logger.log(`Deleted ${deleted} expired ADIF source objects`);
      } catch (error) {
        this.logger.error(`ADIF retention sweep failed: ${safeError(error)}`);
      }
      await this.wait(RETENTION_INTERVAL_SECONDS * 1000);
    }
  }

  private async reconcileQueuedOutbox(): Promise<void> {
    while (!this.stopping) {
      try {
        const repaired = await this.repository.reconcileQueuedWorkOutbox();
        if (repaired)
          this.logger.warn(
            `Repaired ${repaired} queued Activity work outbox rows`,
          );
      } catch (error) {
        this.logger.error(`Activity work recovery failed: ${safeError(error)}`);
      }
      await this.wait(WORK_RECONCILE_SECONDS * 1000);
    }
  }

  private async wait(milliseconds: number): Promise<void> {
    await Promise.race([pause(milliseconds), this.stopSignal]);
  }
}

function validateEnvelope(
  definition: WorkDefinition,
  envelope: Record<string, unknown>,
  subject: string,
): void {
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
  const workId = envelope.workId;
  const aggregate = envelope.aggregate;
  const payload = envelope.payload;
  if (
    envelope.envelopeVersion !== 1 ||
    envelope.workType !== definition.workType ||
    envelope.producer !== 'activity-service' ||
    typeof envelope.createdAt !== 'string' ||
    !envelope.createdAt.endsWith('Z') ||
    typeof workId !== 'string' ||
    !UUID.test(workId) ||
    (envelope.causationId !== undefined &&
      (typeof envelope.causationId !== 'string' ||
        envelope.causationId.length > 200)) ||
    !isRecord(aggregate) ||
    aggregate.type !== 'activity_job' ||
    aggregate.id !== workId ||
    Object.keys(aggregate).length !== 2 ||
    !isRecord(payload) ||
    Object.keys(payload).length !== 1 ||
    payload.jobId !== workId ||
    subject !== definition.subject ||
    Object.keys(envelope).some((key) => !allowed.has(key))
  ) {
    throw new Error('work_contract_mismatch');
  }
  if (
    envelope.correlationId !== undefined &&
    (typeof envelope.correlationId !== 'string' ||
      envelope.correlationId.length < 1 ||
      envelope.correlationId.length > 128 ||
      /[^\x21-\x7e]/.test(envelope.correlationId))
  ) {
    throw new Error('invalid_correlation_id');
  }
}

function kindFromWorkType(workType: string): string {
  return workType
    .replace(/^activity\./, '')
    .replace(/\.v1$/, '')
    .replaceAll('-', '_')
    .toUpperCase();
}

function consumerPolicy(durable: string): {
  ackWaitSeconds: number;
  maxAckPending: number;
  maxWaiting: number;
} {
  const policies: Record<string, [number, number]> = {
    'activity-qso-ingestion-v1': [4, 4],
    'activity-adif-import-v1': [1, 1],
    'activity-award-recalculate-v1': [2, 2],
    'activity-award-evaluation-v1': [2, 2],
    'activity-pdf-render-v1': [1, 1],
    'activity-statistics-rebuild-v1': [1, 1],
  };
  const policy = policies[durable];
  if (!policy) throw new Error(`No consumer policy registered for ${durable}`);
  return {
    ackWaitSeconds:
      durable.includes('adif') ||
      durable.includes('pdf') ||
      durable.includes('statistics')
        ? 300
        : 120,
    maxAckPending: policy[0],
    maxWaiting: policy[1],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 300);
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
