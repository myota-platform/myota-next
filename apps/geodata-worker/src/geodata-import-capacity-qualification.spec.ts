import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { jetstreamManager } from '@nats-io/jetstream';
import { connect } from '@nats-io/transport-node';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { vi } from 'vitest';
import { stringifyJsonWithBigInts } from '../../../libs/platform/src/json-bigint.js';
import { GeodataImportService } from '../../geodata/src/geodata-import.service.js';
import { GeodataDeletionRepository } from './geodata-deletion.repository.js';
import { GeodataEnrichmentRepository } from './geodata-enrichment.repository.js';
import { GeodataPromotionRepository } from './geodata-promotion.repository.js';
import { GeodataRetentionRepository } from './geodata-retention.repository.js';
import { GeodataWorkRepository } from './geodata-work.repository.js';
import { GeodataWorkerService } from './geodata-worker.service.js';
import { OutboxWorkerService } from '../../outbox-worker/src/outbox-worker.service.js';

const enabled = process.env.MYOTA_GEODATA_CAPACITY_QUALIFICATION === '1';
const targetFeatureCount = 5_000;
const databasePoolMaximum = 10;
const workStream = 'MYOTA_GEODATA_WORK';
const workDurable = 'geodata-import-preprocess-v1';

describe('Geodata asynchronous import capacity qualification', () => {
  it.skipIf(!enabled)(
    'measures a maximum-feature import through API, outbox, JetStream, and database staging',
    async () => {
      const databaseUrl = process.env.GEO_DATABASE_URL;
      const natsUrl = process.env.NATS_URL;
      if (!databaseUrl || !natsUrl)
        throw new Error(
          'Geodata import capacity qualification requires PostgreSQL and NATS',
        );
      assertLocalGeodataDatabase(databaseUrl);
      const resourceLimits = await readCgroupLimits();
      if (
        resourceLimits.cpuLimitCores === null ||
        resourceLimits.cpuLimitCores > 1 ||
        resourceLimits.memoryLimitBytes === null ||
        resourceLimits.memoryLimitBytes > 1024 ** 3
      ) {
        throw new Error(
          'Geodata import capacity qualification requires a cgroup CPU limit of 1 core and memory limit of 1 GiB',
        );
      }

      const programmeSlug = `capacity-import-${randomUUID()}`;
      const startedAt = new Date();
      const sourceFeatures = createFeatureWorkload(targetFeatureCount);
      let storedSource: Buffer | undefined;
      let importId: string | undefined;
      let sampling = false;
      let successfulSamples = 0;
      let failedSamples = 0;
      let lastSamplingError = '';
      const maxima = {
        workStreamMessages: 0,
        workStreamBytes: 0,
        eventStreamMessages: 0,
        eventStreamBytes: 0,
        workPending: 0,
        workAckPending: 0,
        activeDatabaseConnections: 0,
      };
      const apiPool = new Pool({
        connectionString: databaseUrl,
        max: databasePoolMaximum,
        application_name: 'myota-geodata-capacity-api',
      });
      const workerPool = new Pool({
        connectionString: databaseUrl,
        max: databasePoolMaximum,
        application_name: 'myota-geodata-capacity-worker',
      });
      const outboxPool = new Pool({
        connectionString: databaseUrl,
        max: databasePoolMaximum,
        application_name: 'myota-geodata-capacity-outbox',
      });
      const importService = new GeodataImportService(apiPool);
      const worker = new GeodataWorkerService(
        new GeodataWorkRepository(workerPool),
        new GeodataPromotionRepository(workerPool),
        new GeodataEnrichmentRepository(workerPool),
        new GeodataDeletionRepository(workerPool),
        new GeodataRetentionRepository(workerPool),
        workerPool,
      );
      const outbox = new OutboxWorkerService(outboxPool);
      const monitor = await connect({
        servers: natsUrl,
        name: 'myota-geodata-capacity-monitor',
        timeout: 5_000,
        reconnect: false,
      });
      const manager = await jetstreamManager(monitor);
      const rssBeforeBytes = process.resourceUsage().maxRSS * 1024;
      const databaseBefore = await databaseStats(apiPool);
      const s3Mock = vi
        .spyOn(S3Client.prototype, 'send')
        .mockImplementation(async (command) => {
          if (command instanceof PutObjectCommand) {
            const body = command.input.Body;
            storedSource = Buffer.isBuffer(body)
              ? Buffer.from(body)
              : Buffer.from(body as Uint8Array);
            return {} as never;
          }
          if (command instanceof GetObjectCommand) {
            if (!storedSource)
              throw new Error('capacity fixture has no source');
            return {
              Body: Readable.from([Buffer.from(storedSource)]),
              ContentLength: storedSource.length,
            } as never;
          }
          if (command instanceof DeleteObjectCommand) return {} as never;
          throw new Error(
            `unexpected S3 operation ${command.constructor.name}`,
          );
        });
      let maximumSampler: NodeJS.Timeout | undefined;
      const sample = async () => {
        if (sampling) return;
        sampling = true;
        try {
          const [work, events, consumer, connections] = await Promise.all([
            manager.streams.info(workStream),
            manager.streams.info('MYOTA_EVENTS'),
            manager.consumers.info(workStream, workDurable),
            apiPool.query<{ count: string }>(
              `SELECT count(*)::text AS count FROM pg_stat_activity
               WHERE datname=current_database() AND state='active'`,
            ),
          ]);
          maxima.workStreamMessages = Math.max(
            maxima.workStreamMessages,
            Number(work.state.messages),
          );
          maxima.workStreamBytes = Math.max(
            maxima.workStreamBytes,
            Number(work.state.bytes),
          );
          maxima.eventStreamMessages = Math.max(
            maxima.eventStreamMessages,
            Number(events.state.messages),
          );
          maxima.eventStreamBytes = Math.max(
            maxima.eventStreamBytes,
            Number(events.state.bytes),
          );
          maxima.workPending = Math.max(
            maxima.workPending,
            Number(consumer.num_pending),
          );
          maxima.workAckPending = Math.max(
            maxima.workAckPending,
            Number(consumer.num_ack_pending),
          );
          maxima.activeDatabaseConnections = Math.max(
            maxima.activeDatabaseConnections,
            Number(connections.rows[0]?.count ?? 0),
          );
          successfulSamples++;
        } catch (error) {
          failedSamples++;
          lastSamplingError =
            error instanceof Error
              ? `${error.name}: ${error.message}`
              : String(error);
          lastSamplingError = lastSamplingError.replace(
            /(postgres(?:ql)?:\/\/|nats:\/\/)[^@\s]+@/g,
            '$1[redacted]@',
          );
        } finally {
          sampling = false;
        }
      };

      try {
        await worker.onModuleInit();
        await outbox.onModuleInit();
        await sample();
        maximumSampler = setInterval(() => void sample(), 100);

        const apiStartedAt = performance.now();
        const imported = await importService.create(undefined, {
          adapter: 'MANUAL',
          format: 'GEOJSON',
          filename: 'capacity-qualification.geojson',
          programmeSlug,
          entityTypes: [`CAPACITY_${randomUUID().slice(0, 8).toUpperCase()}`],
          source: {
            name: 'capacity-qualification',
            sourceKey: programmeSlug,
            license: 'CC0-1.0',
            attribution: 'MyOTA capacity qualification fixture',
            retrievedAt: new Date().toISOString(),
          },
          features: sourceFeatures,
        });
        const apiAdmissionMilliseconds = performance.now() - apiStartedAt;
        importId = String(imported.id);
        expect(storedSource?.byteLength).toBeGreaterThan(0);
        const completed = await waitForPreprocessing(apiPool, importId, sample);
        await waitForPendingOutbox(apiPool, importId);
        await sample();
        expect(
          successfulSamples,
          `Capacity telemetry never sampled successfully (${lastSamplingError || 'unknown error'})`,
        ).toBeGreaterThan(0);
        const staged = await apiPool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM geodata_import_candidate
           WHERE import_run_id=$1`,
          [importId],
        );
        expect(Number(staged.rows[0]?.count)).toBe(targetFeatureCount);
        expect(Number(completed.stats.preprocessed)).toBe(targetFeatureCount);
        expect(Number(completed.stats.errors)).toBe(0);
        const pendingOutbox = await apiPool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM outbox_event
           WHERE occurred_at >= $1 AND aggregate_id=$2 AND published_at IS NULL`,
          [startedAt, importId],
        );
        const databaseAfter = await databaseStats(apiPool);
        const rssAfterBytes = process.resourceUsage().maxRSS * 1024;
        console.info(
          stringifyJsonWithBigInts({
            qualification: 'geodata-import-capacity',
            measuredAt: new Date().toISOString(),
            environment: {
              node: process.version,
              ...resourceLimits,
              cpuLimitCores: 1,
              memoryLimitBytes: 1024 ** 3,
              geodataImportConcurrency: 1,
              geodataApiReplicas: 2,
              geodataWorkerReplicas: 1,
              geodataDatabasePoolMaximum: databasePoolMaximum,
              outboxDatabasePoolMaximum: databasePoolMaximum,
            },
            import: {
              featureCount: targetFeatureCount,
              sourceBytes: storedSource?.byteLength ?? 0,
              apiAdmissionMilliseconds: Math.round(apiAdmissionMilliseconds),
              preprocessingWaitMilliseconds: Math.round(
                Number(completed.preprocessingWaitMilliseconds),
              ),
              totalApiAndWorkerMilliseconds: Math.round(
                apiAdmissionMilliseconds +
                  completed.preprocessingWaitMilliseconds,
              ),
              completedAt: completed.completedAt,
              workerLatencyMilliseconds: completed.workerLatencyMilliseconds,
              featureThroughputPerSecond: Math.round(
                (targetFeatureCount * 1000) /
                  (apiAdmissionMilliseconds +
                    completed.preprocessingWaitMilliseconds),
              ),
              stagedFeatureCount: Number(staged.rows[0]?.count),
              errors: Number(completed.stats.errors),
            },
            database: {
              statsDelta: databaseStatsDelta(databaseBefore, databaseAfter),
              peakActiveConnections: maxima.activeDatabaseConnections,
              pendingOutboxEventsAtFinish: Number(pendingOutbox.rows[0]?.count),
            },
            jetstream: maxima,
            telemetrySampling: {
              successfulSamples,
              failedSamples,
              lastError: lastSamplingError || undefined,
            },
            peakProcessRssGrowthBytes: Math.max(
              0,
              rssAfterBytes - rssBeforeBytes,
            ),
          }),
        );
      } finally {
        if (maximumSampler) clearInterval(maximumSampler);
        s3Mock.mockRestore();
        try {
          await outbox.onModuleDestroy().catch(() => undefined);
          await worker.onModuleDestroy().catch(() => undefined);
          await monitor.drain().catch(() => undefined);
          if (importId) await removeImportFixture(apiPool, importId, startedAt);
        } finally {
          await Promise.all([
            apiPool.end(),
            workerPool.end(),
            outboxPool.end(),
          ]);
        }
      }
    },
    20 * 60 * 1000,
  );
});

function createFeatureWorkload(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const longitude = -160 + index * 0.05;
    return {
      type: 'Feature',
      id: `capacity-import-${String(index).padStart(5, '0')}`,
      properties: {
        name: `Capacity feature ${String(index).padStart(5, '0')}`,
        sourceRef: `capacity-import-${String(index).padStart(5, '0')}`,
      },
      geometry: {
        type: 'Point',
        coordinates: [longitude, -70],
      },
    };
  });
}

async function waitForPreprocessing(
  pool: Pool,
  importId: string,
  sample: () => Promise<void>,
) {
  const startedAt = performance.now();
  const timeoutAt = Date.now() + 15 * 60 * 1000;
  while (Date.now() < timeoutAt) {
    const result = await pool.query<{
      status: string;
      stats: Record<string, unknown>;
      started_at: Date;
      completed_at: Date | null;
    }>(
      `SELECT status,stats,started_at,completed_at FROM import_run WHERE id=$1`,
      [importId],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Geodata import ${importId} disappeared`);
    await sample();
    if (
      row.status === 'PREPROCESSED' ||
      row.status === 'PREPROCESSED_WITH_ERRORS'
    ) {
      const completedAt = row.completed_at?.getTime();
      if (!completedAt)
        throw new Error('Geodata import has no completion time');
      return {
        stats: row.stats,
        completedAt: row.completed_at!.toISOString(),
        preprocessingWaitMilliseconds: performance.now() - startedAt,
        workerLatencyMilliseconds: completedAt - row.started_at.getTime(),
      };
    }
    if (row.status === 'FAILED')
      throw new Error(
        `Geodata import failed: ${stringifyJsonWithBigInts(row.stats)}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for Geodata import ${importId}`);
}

async function waitForPendingOutbox(pool: Pool, importId: string) {
  const timeoutAt = Date.now() + 30_000;
  while (Date.now() < timeoutAt) {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM outbox_event
       WHERE aggregate_id=$1 AND published_at IS NULL`,
      [importId],
    );
    if (Number(result.rows[0]?.count ?? 0) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Geodata capacity import outbox did not drain');
}

async function removeImportFixture(
  pool: Pool,
  importId: string,
  startedAt: Date,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('myota.geodata_writer','row-v1',true)",
    );
    await client.query(
      `DELETE FROM source_snapshot_record WHERE manifest_id IN (
         SELECT id FROM source_snapshot_manifest WHERE import_run_id=$1
       )`,
      [importId],
    );
    await client.query(
      'DELETE FROM source_snapshot_manifest WHERE import_run_id=$1',
      [importId],
    );
    await client.query(
      'DELETE FROM geodata_import_candidate_stage WHERE import_run_id=$1',
      [importId],
    );
    await client.query(
      `DELETE FROM outbox_event WHERE occurred_at >= $1 AND (
         aggregate_id=$2 OR payload->>'importRunId'=$2
       )`,
      [startedAt, importId],
    );
    await client.query('DELETE FROM import_run WHERE id=$1', [importId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function databaseStats(pool: Pool) {
  const result = await pool.query<{
    xact_commit: string;
    tup_inserted: string;
    tup_updated: string;
    blks_read: string;
    blks_hit: string;
    temp_bytes: string;
  }>(
    `SELECT xact_commit::text,tup_inserted::text,tup_updated::text,
       blks_read::text,blks_hit::text,temp_bytes::text
     FROM pg_stat_database WHERE datname=current_database()`,
  );
  const stats = result.rows[0];
  if (!stats) throw new Error('PostgreSQL did not return database statistics');
  return stats;
}

function databaseStatsDelta(
  before: Awaited<ReturnType<typeof databaseStats>>,
  after: Awaited<ReturnType<typeof databaseStats>>,
) {
  return Object.fromEntries(
    Object.keys(before).map((key) => [
      key,
      Number(after[key as keyof typeof after]) -
        Number(before[key as keyof typeof before]),
    ]),
  );
}

function assertLocalGeodataDatabase(connectionString: string) {
  const url = new URL(connectionString);
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    decodeURIComponent(url.pathname.slice(1)) !== 'myota_geo'
  ) {
    throw new Error(
      'Geodata capacity qualification only runs against loopback myota_geo',
    );
  }
}

async function readCgroupLimits() {
  try {
    const [cpu, memory] = await Promise.all([
      readFile('/sys/fs/cgroup/cpu.max', 'utf8'),
      readFile('/sys/fs/cgroup/memory.max', 'utf8'),
    ]);
    const [quota, period] = cpu.trim().split(/\s+/);
    const cpuLimitCores =
      quota === 'max' || !quota || !period
        ? null
        : Number(quota) / Number(period);
    const memoryLimitBytes =
      memory.trim() === 'max' ? null : Number(memory.trim());
    return {
      cpuLimitCores:
        cpuLimitCores !== null && Number.isFinite(cpuLimitCores)
          ? cpuLimitCores
          : null,
      memoryLimitBytes:
        memoryLimitBytes !== null && Number.isFinite(memoryLimitBytes)
          ? memoryLimitBytes
          : null,
    };
  } catch {
    return { cpuLimitCores: null, memoryLimitBytes: null };
  }
}
