import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createServer, type Server } from 'node:http';
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import { connect } from '@nats-io/transport-node';
import type { Pool } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import {
  loadOutboxRegistry,
  OutboxContractError,
  routeOutboxEvent,
  type ClaimedOutboxEvent,
} from '@app/platform/outbox-routing.js';

const OWNER = process.env.OUTBOX_OWNER ?? '';
const WORKER = process.env.OUTBOX_WORKER ?? `${OWNER}-outbox`;
const MAX_ATTEMPTS = Math.max(1, Number(process.env.OUTBOX_MAX_ATTEMPTS ?? 12));
const MAX_MESSAGE_BYTES = Math.max(
  1024,
  Number(process.env.OUTBOX_MAX_MESSAGE_BYTES ?? 1_048_576),
);
const PUBLISH_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.OUTBOX_PUBLISH_TIMEOUT_MS ?? 10_000),
);
const METRICS_PORT = Math.max(
  0,
  Number(process.env.OUTBOX_METRICS_PORT ?? 9108),
);
@Injectable()
export class OutboxWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxWorkerService.name);
  private stopping = false;
  private relay?: ReturnType<typeof jetstream>;
  private connection?: Awaited<ReturnType<typeof connect>>;
  private metricsServer?: Server;
  private published = 0;
  private retries = new Map<string, number>();
  private deadLetters = new Map<string, number>();
  private publishCount = 0;
  private publishDurationSum = 0;
  private publishDurationBuckets = [0, 0, 0, 0, 0, 0, 0];
  private pendingEvents = 0;
  private oldestPendingAge = 0;
  private unresolvedDeadLetters = 0;
  private databaseUp = 0;
  private natsUp = 0;

  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!['core', 'activity', 'geodata'].includes(OWNER))
      throw new Error('OUTBOX_OWNER must be core, activity, or geodata');
    if (!this.pool) throw new Error('OUTBOX_DATABASE_URL is required');
    const registry = await loadOutboxRegistry();
    this.connection = await connect({
      servers: process.env.NATS_URL ?? 'nats://nats:4222',
      name: WORKER,
      timeout: 5000,
      reconnect: true,
      maxReconnectAttempts: -1,
    });
    this.relay = jetstream(this.connection);
    await this.validateTopology(registry);
    this.natsUp = 1;
    void this.monitorNats();
    this.startMetricsServer();
    void this.run(registry);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.metricsServer) {
      await new Promise<void>((resolve, reject) => {
        this.metricsServer!.close((error) =>
          error ? reject(error) : resolve(),
        );
      });
    }
    await this.connection?.drain();
  }

  private async run(
    registry: Awaited<ReturnType<typeof loadOutboxRegistry>>,
  ): Promise<void> {
    let dbRetryMs = 1000;
    let metricsAt = 0;
    while (!this.stopping) {
      try {
        if (Date.now() >= metricsAt) {
          await this.refreshMetrics();
          metricsAt = Date.now() + 15_000;
        }
        const event = await this.claim();
        this.databaseUp = 1;
        dbRetryMs = 1000;
        if (!event) {
          await this.pause(1000);
          continue;
        }
        await this.publish(event, registry);
      } catch (error) {
        this.databaseUp = 0;
        this.logger.error(`Outbox polling failed: ${this.safeError(error)}`);
        await this.pause(dbRetryMs);
        dbRetryMs = Math.min(dbRetryMs * 2, 30_000);
      }
    }
  }

  private startMetricsServer(): void {
    if (METRICS_PORT === 0) return;
    this.metricsServer = createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/healthz') {
        response.writeHead(this.stopping ? 503 : 200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(this.stopping ? 'stopping\n' : 'ok\n');
        return;
      }
      if (request.method === 'GET' && request.url === '/readyz') {
        const ready =
          !this.stopping && this.databaseUp === 1 && this.natsUp === 1;
        response.writeHead(ready ? 200 : 503, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(ready ? 'ready\n' : 'not ready\n');
        return;
      }
      if (request.method !== 'GET' || request.url !== '/metrics') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      });
      response.end(this.renderMetrics());
    });
    this.metricsServer.listen(METRICS_PORT, '0.0.0.0');
  }

  private async monitorNats(): Promise<void> {
    try {
      for await (const status of this.connection!.status()) {
        if (status.type === 'disconnect' || status.type === 'reconnecting') {
          this.natsUp = 0;
        } else if (status.type === 'reconnect') {
          this.natsUp = 1;
        } else if (status.type === 'close') {
          this.natsUp = 0;
          return;
        }
      }
    } catch (error) {
      this.natsUp = 0;
      this.logger.warn(`NATS status monitor stopped: ${this.safeError(error)}`);
    }
  }

  private renderMetrics(): string {
    const worker = this.escapeMetricLabel(WORKER);
    const lines = [
      '# HELP myota_outbox_published_events_total Outbox events acknowledged by JetStream.',
      '# TYPE myota_outbox_published_events_total counter',
      `myota_outbox_published_events_total{worker="${worker}"} ${this.published}`,
      '# HELP myota_outbox_retries_total Outbox events scheduled for retry.',
      '# TYPE myota_outbox_retries_total counter',
      ...this.renderFailureCounters('myota_outbox_retries_total', this.retries),
      '# HELP myota_outbox_dead_lettered_events_total Outbox events persisted as dead letters.',
      '# TYPE myota_outbox_dead_lettered_events_total counter',
      ...this.renderFailureCounters(
        'myota_outbox_dead_lettered_events_total',
        this.deadLetters,
      ),
      '# HELP myota_outbox_publish_duration_seconds Time spent awaiting JetStream publish acknowledgements.',
      '# TYPE myota_outbox_publish_duration_seconds histogram',
      ...this.publishDurationBuckets.map(
        (count, index) =>
          `myota_outbox_publish_duration_seconds_bucket{worker="${worker}",le="${[0.1, 0.25, 0.5, 1, 2.5, 5, 10][index]}"} ${count}`,
      ),
      `myota_outbox_publish_duration_seconds_bucket{worker="${worker}",le="+Inf"} ${this.publishCount}`,
      `myota_outbox_publish_duration_seconds_sum{worker="${worker}"} ${this.publishDurationSum}`,
      `myota_outbox_publish_duration_seconds_count{worker="${worker}"} ${this.publishCount}`,
      '# HELP myota_outbox_pending_events Unpublished outbox events in this database.',
      '# TYPE myota_outbox_pending_events gauge',
      `myota_outbox_pending_events{worker="${worker}"} ${this.pendingEvents}`,
      '# HELP myota_outbox_oldest_pending_age_seconds Age of the oldest unpublished event.',
      '# TYPE myota_outbox_oldest_pending_age_seconds gauge',
      `myota_outbox_oldest_pending_age_seconds{worker="${worker}"} ${this.oldestPendingAge}`,
      '# HELP myota_outbox_unresolved_dead_letters Unresolved outbox dead letters.',
      '# TYPE myota_outbox_unresolved_dead_letters gauge',
      `myota_outbox_unresolved_dead_letters{worker="${worker}"} ${this.unresolvedDeadLetters}`,
      '# HELP myota_outbox_database_up Whether the last outbox database operation succeeded.',
      '# TYPE myota_outbox_database_up gauge',
      `myota_outbox_database_up{worker="${worker}"} ${this.databaseUp}`,
      '# HELP myota_outbox_nats_up Whether the relay is connected to NATS.',
      '# TYPE myota_outbox_nats_up gauge',
      `myota_outbox_nats_up{worker="${worker}"} ${this.natsUp}`,
    ];
    return `${lines.join('\n')}\n`;
  }

  private renderFailureCounters(
    name: string,
    counters: Map<string, number>,
  ): string[] {
    const worker = this.escapeMetricLabel(WORKER);
    return [...counters.entries()].map(
      ([failureClass, count]) =>
        `${name}{worker="${worker}",failure_class="${failureClass}"} ${count}`,
    );
  }

  private escapeMetricLabel(value: string): string {
    return value
      .replaceAll('\\', '\\\\')
      .replaceAll('"', '\\"')
      .replaceAll('\n', '\\n');
  }

  private async refreshMetrics(): Promise<void> {
    const result = await this.pool!.query<{
      pending: string;
      oldest_age: string;
      dead_letters: string;
    }>(
      `SELECT (SELECT count(*) FROM public.outbox_event WHERE published_at IS NULL)::text AS pending,
        (SELECT COALESCE(max(EXTRACT(EPOCH FROM (now() - occurred_at))), 0)
          FROM public.outbox_event WHERE published_at IS NULL)::text AS oldest_age,
        (SELECT count(*) FROM public.dead_letter_event WHERE resolved_at IS NULL)::text AS dead_letters`,
    );
    const row = result.rows[0];
    this.pendingEvents = Number(row?.pending ?? 0);
    this.oldestPendingAge = Math.max(0, Number(row?.oldest_age ?? 0));
    this.unresolvedDeadLetters = Number(row?.dead_letters ?? 0);
    this.databaseUp = 1;
  }

  private observePublish(seconds: number): void {
    const bounds = [0.1, 0.25, 0.5, 1, 2.5, 5, 10];
    this.publishCount += 1;
    this.publishDurationSum += seconds;
    bounds.forEach((bound, index) => {
      if (seconds <= bound) this.publishDurationBuckets[index] += 1;
    });
  }

  private async validateTopology(
    registry: Awaited<ReturnType<typeof loadOutboxRegistry>>,
  ): Promise<void> {
    const manager = await jetstreamManager(this.connection!);
    const required: Array<{
      name: string;
      subject: string;
      retention: string;
    }> = [
      { name: 'MYOTA_EVENTS', subject: 'myota.events.>', retention: 'limits' },
    ];
    const ownedWork = registry.work.filter((work) =>
      OWNER === 'activity'
        ? work.owner === 'activity-service'
        : OWNER === 'geodata' && work.owner === 'geodata-service',
    );
    if (OWNER === 'activity' && ownedWork.length) {
      required.push({
        name: 'MYOTA_ACTIVITY_WORK',
        subject: 'myota.work.activity.>',
        retention: 'workqueue',
      });
    }
    if (OWNER === 'geodata' && ownedWork.length) {
      required.push({
        name: 'MYOTA_GEODATA_WORK',
        subject: 'myota.work.geodata.>',
        retention: 'workqueue',
      });
    }

    for (const expected of required) {
      const info = await manager.streams.info(expected.name);
      const config = info.config;
      if (
        config.subjects.length !== 1 ||
        config.subjects[0] !== expected.subject ||
        String(config.retention).toLowerCase() !== expected.retention ||
        String(config.storage).toLowerCase() !== 'file' ||
        config.num_replicas !== 1 ||
        String(config.discard).toLowerCase() !== 'new' ||
        Math.min(
          config.max_age,
          config.max_bytes,
          config.max_msgs,
          config.max_msg_size,
        ) <= 0
      ) {
        throw new Error(
          `JetStream stream ${expected.name} does not match bounded topology`,
        );
      }
    }

    const notificationSubjects = [
      'myota.events.geodata.entity.reviewed.v1',
      'myota.events.geodata.entity.status-changed.v1',
      'myota.events.identity.account.admin-updated.v1',
      'myota.events.identity.account.created.v1',
      'myota.events.identity.account.deactivated.v1',
      'myota.events.identity.bootstrap-admin.created.v1',
      'myota.events.identity.callsign.added.v1',
      'myota.events.identity.callsign.evidence-submitted.v1',
      'myota.events.identity.callsign.primary-changed.v1',
      'myota.events.identity.callsign.retired.v1',
      'myota.events.identity.callsign.verified.v1',
      'myota.events.identity.login.failed.v1',
      'myota.events.identity.login.succeeded.v1',
      'myota.events.identity.oidc.mapping.updated.v1',
      'myota.events.identity.recovery.completed.v1',
      'myota.events.identity.recovery.requested.v1',
      'myota.events.identity.role-definition.created.v1',
      'myota.events.identity.role-definition.updated.v1',
      'myota.events.identity.role.assigned.v1',
      'myota.events.identity.roles.replaced.v1',
      'myota.events.identity.service-token.issued.v1',
    ];
    const notificationInfo = await manager.consumers.info(
      'MYOTA_EVENTS',
      'activity-notifications-v1',
    );
    const notification = notificationInfo.config;
    const backoff = [60, 120, 300, 300, 300, 300, 300].map(
      (seconds) => seconds * 1_000_000_000,
    );
    if (
      JSON.stringify(notification.filter_subjects ?? []) !==
        JSON.stringify(notificationSubjects) ||
      String(notification.ack_policy).toLowerCase() !== 'explicit' ||
      Number(notification.ack_wait) !== 60_000_000_000 ||
      notification.max_deliver !== 8 ||
      notification.max_ack_pending !== 64 ||
      notification.max_waiting !== 32 ||
      String(notification.deliver_policy).toLowerCase() !== 'all' ||
      String(notification.replay_policy).toLowerCase() !== 'instant' ||
      notification.deliver_subject != null ||
      JSON.stringify(notification.backoff ?? []) !== JSON.stringify(backoff)
    ) {
      throw new Error(
        'MYOTA_EVENTS/activity-notifications-v1 does not match required topology',
      );
    }

    if (OWNER === 'activity' || OWNER === 'geodata') {
      const stream =
        OWNER === 'activity' ? 'MYOTA_ACTIVITY_WORK' : 'MYOTA_GEODATA_WORK';
      const expectedCount = OWNER === 'activity' ? 6 : 4;
      if (ownedWork.length !== expectedCount) {
        throw new Error(
          `${stream} work routes are incomplete in the event registry`,
        );
      }
      for (const work of ownedWork) {
        const info = await manager.consumers.info(stream, work.durable);
        const config = info.config;
        if (
          config.filter_subject !== work.subject ||
          String(config.ack_policy).toLowerCase() !== 'explicit' ||
          Number(config.ack_wait) !== this.expectedAckWait(work.durable) ||
          config.max_deliver !==
            (OWNER === 'activity'
              ? 8
              : work.durable === 'geodata-entity-deletion-v1'
                ? 100
                : work.durable === 'geodata-preprocessing-v1' ||
                    work.durable === 'geodata-import-promotion-v1'
                  ? 100
                  : 8) ||
          config.max_ack_pending !== this.expectedPending(work.durable) ||
          config.max_waiting !== this.expectedPending(work.durable) ||
          String(config.deliver_policy).toLowerCase() !== 'all' ||
          String(config.replay_policy).toLowerCase() !== 'instant' ||
          config.deliver_subject != null
        ) {
          throw new Error(
            `JetStream durable ${stream}/${work.durable} does not match its registered policy`,
          );
        }
      }
    }
  }

  private expectedAckWait(durable: string): number {
    const seconds: Record<string, number> = {
      'activity-qso-ingestion-v1': 120,
      'activity-adif-import-v1': 300,
      'activity-award-recalculate-v1': 120,
      'activity-award-evaluation-v1': 120,
      'activity-pdf-render-v1': 300,
      'activity-statistics-rebuild-v1': 300,
      'geodata-preprocessing-v1': 300,
      'geodata-import-promotion-v1': 300,
      'geodata-entity-deletion-v1': 120,
      'geodata-location-enrichment-v1': 120,
    };
    const value = seconds[durable];
    if (!value)
      throw new Error(`No acknowledgement policy is registered for ${durable}`);
    return value * 1_000_000_000;
  }

  private expectedPending(durable: string): number {
    const values: Record<string, number> = {
      'activity-qso-ingestion-v1': 4,
      'activity-adif-import-v1': 1,
      'activity-award-recalculate-v1': 2,
      'activity-award-evaluation-v1': 2,
      'activity-pdf-render-v1': 1,
      'activity-statistics-rebuild-v1': 1,
      'geodata-preprocessing-v1': 1,
      'geodata-import-promotion-v1': 1,
      'geodata-entity-deletion-v1': 1,
      'geodata-location-enrichment-v1': 4,
    };
    const value = values[durable];
    if (!value)
      throw new Error(`No pending policy is registered for ${durable}`);
    return value;
  }

  private async claim(): Promise<ClaimedOutboxEvent | null> {
    const result = await this.pool!.query<ClaimedOutboxEvent>(
      `WITH next_event AS (
         SELECT event_id FROM public.outbox_event
         WHERE published_at IS NULL AND available_at <= now()
         ORDER BY occurred_at, event_id FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE public.outbox_event e SET attempts = e.attempts + 1
       FROM next_event n WHERE e.event_id = n.event_id
       RETURNING e.event_id AS "eventId", e.event_type AS "eventType",
         e.producer, e.aggregate_type AS "aggregateType", e.aggregate_id AS "aggregateId",
         e.payload, e.occurred_at AS "occurredAt", e.attempts, e.correlation_id AS "correlationId"`,
    );
    return result.rows[0] ?? null;
  }

  private async publish(
    event: ClaimedOutboxEvent,
    registry: Awaited<ReturnType<typeof loadOutboxRegistry>>,
  ): Promise<void> {
    let routed;
    let body: Uint8Array;
    try {
      routed = routeOutboxEvent(event, registry, OWNER);
      if (!routed.stream)
        throw new OutboxContractError('registered work stream is missing');
      body = new TextEncoder().encode(
        stringifyJsonWithBigInts(routed.envelope),
      );
      if (body.byteLength > MAX_MESSAGE_BYTES)
        throw new OutboxContractError(
          `serialized event exceeds ${MAX_MESSAGE_BYTES} bytes`,
        );
    } catch (error) {
      await this.markFailed(event, error, true);
      return;
    }

    const started = performance.now();
    let brokerAcknowledged = false;
    let publishObserved = false;
    try {
      const ack = await this.relay!.publish(routed.subject, body, {
        msgID: event.eventId,
        timeout: PUBLISH_TIMEOUT_MS,
      });
      brokerAcknowledged = true;
      this.natsUp = 1;
      this.observePublish((performance.now() - started) / 1000);
      publishObserved = true;
      if (ack.stream !== routed.stream)
        throw new Error('JetStream acknowledged an unexpected stream');
      this.published += 1;
      const client = await this.pool!.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'UPDATE public.outbox_event SET published_at = now(), last_error = NULL WHERE event_id = $1',
          [event.eventId],
        );
        await client.query(
          'UPDATE public.dead_letter_event SET resolved_at = now() WHERE event_id = $1 AND resolved_at IS NULL',
          [event.eventId],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      if (!brokerAcknowledged) this.natsUp = 0;
      if (!publishObserved)
        this.observePublish((performance.now() - started) / 1000);
      if (error instanceof OutboxContractError)
        await this.markFailed(event, error, true);
      else await this.markFailed(event, error, false);
    }
  }

  private async markFailed(
    event: ClaimedOutboxEvent,
    error: unknown,
    permanent: boolean,
  ): Promise<void> {
    const message = this.safeError(error);
    const dead = permanent || event.attempts >= MAX_ATTEMPTS;
    const client = await this.pool!.connect();
    try {
      await client.query('BEGIN');
      if (dead) {
        await client.query(
          `INSERT INTO public.dead_letter_event(event_id, event_type, payload, attempts, error, dead_lettered_at, resolved_at)
         VALUES ($1, $2, $3::jsonb, $4, $5, now(), NULL)
         ON CONFLICT (event_id) DO UPDATE SET event_type = EXCLUDED.event_type,
           payload = EXCLUDED.payload, attempts = EXCLUDED.attempts, error = EXCLUDED.error,
           dead_lettered_at = now(), resolved_at = NULL`,
          [
            event.eventId,
            event.eventType,
            stringifyJsonWithBigInts(event.payload),
            event.attempts,
            message,
          ],
        );
        await client.query(
          'UPDATE public.outbox_event SET published_at = now(), last_error = $1 WHERE event_id = $2',
          [`dead-lettered: ${message}`, event.eventId],
        );
        await client.query('COMMIT');
        const failureClass =
          error instanceof OutboxContractError ? 'contract' : 'publish';
        const counters = dead ? this.deadLetters : this.retries;
        counters.set(failureClass, (counters.get(failureClass) ?? 0) + 1);
        this.logger.error(
          `Dead-lettered event ${event.eventId} (${event.eventType}): ${message}`,
        );
        return;
      }
      const base = Math.min(300, 2 ** Math.min(Math.max(1, event.attempts), 8));
      const delay = Math.min(
        300,
        Math.max(1, base * (0.8 + Math.random() * 0.4)),
      );
      await client.query(
        'UPDATE public.outbox_event SET available_at = now() + make_interval(secs => $1), last_error = $2 WHERE event_id = $3',
        [delay, message, event.eventId],
      );
      await client.query('COMMIT');
      const failureClass =
        error instanceof OutboxContractError ? 'contract' : 'publish';
      this.retries.set(failureClass, (this.retries.get(failureClass) ?? 0) + 1);
      this.logger.warn(
        `Scheduled retry for event ${event.eventId}: ${message}`,
      );
    } catch (failure) {
      await client.query('ROLLBACK');
      throw failure;
    } finally {
      client.release();
    }
  }

  private safeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/[\r\n\t]+/g, ' ').slice(0, 1000);
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
