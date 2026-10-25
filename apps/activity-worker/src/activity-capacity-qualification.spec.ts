import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { jetstreamManager } from '@nats-io/jetstream';
import { connect } from '@nats-io/transport-node';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { signAccessToken } from '../../../libs/platform/src/access-token.js';
import { ActivityRepository } from '../../activity/src/activity.repository.js';
import { ActivityService } from '../../activity/src/activity.service.js';
import { ActivityAwardsRepository } from '../../activity/src/activity-awards.repository.js';
import { AwardsService } from '../../activity/src/awards.service.js';
import { ActivityWorkerService } from './activity-worker.service.js';
import { ActivityWorkRepository } from './activity-work.repository.js';
import { ActivityRetentionRepository } from './activity-retention.repository.js';
import { OutboxWorkerService } from '../../outbox-worker/src/outbox-worker.service.js';

const enabled = process.env.MYOTA_ACTIVITY_CAPACITY_QUALIFICATION === '1';
const targetQsoCount = 5_000;
const adifUploadLimitBytes = 25 * 1024 * 1024;
const databasePoolMaximum = 12;
const qsoDurable = 'activity-qso-ingestion-v1';
const awardDurable = 'activity-award-recalculate-v1';
const enforcedCpuLimitCores = 1;
const enforcedMemoryLimitBytes = 1024 ** 3;

type DatabaseStats = {
  xact_commit: string;
  tup_inserted: string;
  tup_updated: string;
  blks_read: string;
  blks_hit: string;
  temp_bytes: string;
};

describe('Activity launch capacity qualification', () => {
  it.skipIf(!enabled)(
    'measures maximum log upload, QSO ingestion, awards, sync actions, and broker backlog',
    async () => {
      const activityDatabaseUrl = process.env.ACTIVITY_DATABASE_URL;
      const natsUrl = process.env.NATS_URL;
      if (!activityDatabaseUrl || !natsUrl)
        throw new Error(
          'Activity capacity qualification requires ACTIVITY_DATABASE_URL and NATS_URL',
        );
      assertLocalActivityDatabase(activityDatabaseUrl);
      const resourceLimits = await readCgroupLimits();
      if (process.env.MYOTA_ACTIVITY_CAPACITY_ENFORCE_LIMITS === '1') {
        if (
          resourceLimits.cpuLimitCores === null ||
          resourceLimits.cpuLimitCores > enforcedCpuLimitCores ||
          resourceLimits.memoryLimitBytes === null ||
          resourceLimits.memoryLimitBytes > enforcedMemoryLimitBytes
        ) {
          throw new Error(
            'Activity capacity qualification requires a cgroup CPU limit of 1 core and memory limit of 1 GiB',
          );
        }
      }

      const programmeSlug = `capacity-${randomUUID()}`;
      const idPrefix = `${programmeSlug}-subject-`;
      const operatorId = `${programmeSlug}-operator`;
      const operatorCallsign = 'EA1CAP';
      const activationStart = '2026-01-01T00:00:00.000Z';
      const authKey = process.env.MYOTA_AUTH_SIGNING_KEY;
      const environment = process.env.MYOTA_ENV;
      const uploadLimit = process.env.MYOTA_UPLOAD_MAX_BYTES;
      const clamavUrl = process.env.MYOTA_CLAMAV_URL;
      process.env.MYOTA_AUTH_SIGNING_KEY ??= 'activity-capacity-test-key';
      process.env.MYOTA_ENV = 'testing';
      process.env.MYOTA_UPLOAD_MAX_BYTES = String(adifUploadLimitBytes);
      delete process.env.MYOTA_CLAMAV_URL;

      const apiPool = new Pool({
        connectionString: activityDatabaseUrl,
        max: databasePoolMaximum,
        application_name: 'myota-activity-capacity-api',
      });
      const workerPool = new Pool({
        connectionString: activityDatabaseUrl,
        max: databasePoolMaximum,
        application_name: 'myota-activity-capacity-worker',
      });
      const outboxPool = new Pool({
        connectionString: activityDatabaseUrl,
        max: databasePoolMaximum,
        application_name: 'myota-activity-capacity-outbox',
      });
      const activity = new ActivityRepository(apiPool);
      const awardsRepository = new ActivityAwardsRepository(apiPool);
      const activityService = new ActivityService(activity);
      const awardsService = new AwardsService(activity, awardsRepository);
      const workerRepository = new ActivityWorkRepository(workerPool);
      const apiAuthorization = `Bearer ${signAccessToken(operatorId, [])}`;
      const monitorConnection = await connect({
        servers: natsUrl,
        name: 'myota-activity-capacity-monitor',
        timeout: 5_000,
        reconnect: false,
      });
      const manager = await jetstreamManager(monitorConnection);
      const maxBacklog = {
        workStreamMessages: 0,
        workStreamBytes: 0,
        eventStreamMessages: 0,
        eventStreamBytes: 0,
        qsoPending: 0,
        qsoAckPending: 0,
        awardPending: 0,
        awardAckPending: 0,
        activeDatabaseConnections: 0,
      };
      let sampling = false;
      const sampleBacklog = async () => {
        if (sampling) return;
        sampling = true;
        try {
          const [work, events, qso, award, connections] = await Promise.all([
            manager.streams.info('MYOTA_ACTIVITY_WORK'),
            manager.streams.info('MYOTA_EVENTS'),
            manager.consumers.info('MYOTA_ACTIVITY_WORK', qsoDurable),
            manager.consumers.info('MYOTA_ACTIVITY_WORK', awardDurable),
            apiPool.query<{ count: string }>(
              `SELECT count(*)::text AS count FROM pg_stat_activity
               WHERE datname=current_database() AND state='active'`,
            ),
          ]);
          maxBacklog.workStreamMessages = Math.max(
            maxBacklog.workStreamMessages,
            Number(work.state.messages),
          );
          maxBacklog.workStreamBytes = Math.max(
            maxBacklog.workStreamBytes,
            Number(work.state.bytes),
          );
          maxBacklog.eventStreamMessages = Math.max(
            maxBacklog.eventStreamMessages,
            Number(events.state.messages),
          );
          maxBacklog.eventStreamBytes = Math.max(
            maxBacklog.eventStreamBytes,
            Number(events.state.bytes),
          );
          maxBacklog.qsoPending = Math.max(
            maxBacklog.qsoPending,
            Number(qso.num_pending),
          );
          maxBacklog.qsoAckPending = Math.max(
            maxBacklog.qsoAckPending,
            Number(qso.num_ack_pending),
          );
          maxBacklog.awardPending = Math.max(
            maxBacklog.awardPending,
            Number(award.num_pending),
          );
          maxBacklog.awardAckPending = Math.max(
            maxBacklog.awardAckPending,
            Number(award.num_ack_pending),
          );
          maxBacklog.activeDatabaseConnections = Math.max(
            maxBacklog.activeDatabaseConnections,
            Number(connections.rows[0]?.count ?? 0),
          );
        } catch {
          // Topology may still be reconciling during worker startup.
        } finally {
          sampling = false;
        }
      };
      const sampler = setInterval(() => void sampleBacklog(), 250);
      const rssBeforeBytes = process.resourceUsage().maxRSS * 1024;
      const dbBefore = await databaseStats(apiPool);
      const runStartedAt = new Date();
      let activationId: string | undefined;
      let s3Mock: { mockRestore(): void } | undefined;
      let activityWorker: ActivityWorkerService | undefined;
      let outboxWorker: OutboxWorkerService | undefined;

      try {
        const activation = await activity.create({
          programmeSlug,
          entityId: 'CAPACITY-QUALIFICATION',
          entityType: 'MUNICIPAL_PARK',
          operatorId,
          operatorCallsign,
          startedAt: activationStart,
        });
        activationId = String(activation.id);
        await awardsRepository.saveAwardDefinition({
          id: randomUUID(),
          programmeSlug,
          code: 'CAP-ACTIVATOR',
          version: 1,
          status: 'PUBLISHED',
          category: 'ACTIVATOR',
          achievementMetric: 'QSO_COUNT',
          condition: { kind: 'QSO_COUNT', operator: 'GTE', value: 1 },
          levels: [{ id: 'participant', name: 'Participant', threshold: 1 }],
        });
        const hunterAwardId = randomUUID();
        await awardsRepository.saveAwardDefinition({
          id: hunterAwardId,
          programmeSlug,
          code: 'CAP-HUNTER',
          version: 1,
          status: 'PUBLISHED',
          category: 'HUNTER',
          achievementMetric: 'QSO_COUNT',
          condition: { kind: 'QSO_COUNT', operator: 'GTE', value: 1 },
          levels: [{ id: 'participant', name: 'Participant', threshold: 1 }],
        });

        activityWorker = new ActivityWorkerService(
          workerRepository,
          new ActivityRetentionRepository(workerPool),
          workerPool,
        );
        await activityWorker.onModuleInit();
        outboxWorker = new OutboxWorkerService(outboxPool);
        await outboxWorker.onModuleInit();
        await sampleBacklog();

        const adifContent = maximumAdifDocument(targetQsoCount);
        expect(adifContent.byteLength).toBe(adifUploadLimitBytes);
        const s3Send = vi
          .spyOn(S3Client.prototype, 'send')
          .mockImplementation(async (command) => {
            if (command instanceof HeadBucketCommand)
              throw new Error('capacity fixture bucket is not initialized');
            if (
              command instanceof CreateBucketCommand ||
              command instanceof PutObjectCommand
            )
              return {} as never;
            if (command instanceof GetObjectCommand)
              return {
                Body: {
                  transformToByteArray: async () => new Uint8Array(adifContent),
                },
              } as never;
            throw new Error(
              `unexpected S3 operation ${command.constructor.name}`,
            );
          });
        s3Mock = s3Send;

        const adifStartedAt = performance.now();
        const adifImport = await activityService.createAdifImport(
          apiAuthorization,
          {
            activationId,
            filename: 'capacity-qualification.adi',
            contentBase64: adifContent.toString('base64'),
          },
        );
        const adifAdmissionMs = performance.now() - adifStartedAt;
        const adifJobId = await jobIdForImport(apiPool, String(adifImport.id));
        const adifCompleted = await waitForJob(
          activity,
          adifJobId,
          sampleBacklog,
        );
        const adifImportStatus = await activity.getAdifImport(
          String(adifImport.id),
        );
        expect(adifImportStatus.status, JSON.stringify(adifImportStatus)).toBe(
          'COMPLETED',
        );
        expect(Number(adifImportStatus.recordsAccepted)).toBe(targetQsoCount);

        const adifAwardJob = await oldestQueuedAwardJob(apiPool, programmeSlug);
        const adifAwardCompleted = await waitForJob(
          activity,
          adifAwardJob,
          sampleBacklog,
        );

        const qsoRecords = Array.from(
          { length: targetQsoCount },
          (_, index) => {
            const number = String(index).padStart(5, '0');
            const hour = String(Math.floor(index / 3_600) % 24).padStart(
              2,
              '0',
            );
            const minute = String(Math.floor(index / 60) % 60).padStart(2, '0');
            const second = String(index % 60).padStart(2, '0');
            return {
              workedCallsign: `J${number}`,
              hunterId: `${idPrefix}${number}`,
              hunterCallsign: `K${number}`,
              workedEntityId: `ENTITY-${String(index % 1000).padStart(4, '0')}`,
              timestamp: `2026-01-02T${hour}:${minute}:${second}Z`,
              band: '20M',
              mode: 'SSB',
            };
          },
        );
        await activityWorker.onModuleDestroy();
        activityWorker = undefined;
        const qsoStartedAt = performance.now();
        const ingestion = await activityService.enqueueQsoIngestion(
          apiAuthorization,
          `capacity-${programmeSlug}`,
          { activationId, qsos: qsoRecords, sourceFormat: 'JSON' },
        );
        const qsoAdmissionMs = performance.now() - qsoStartedAt;
        expect(ingestion.status).toBe('QUEUED');
        const preRestartBacklog = await waitForPublishedWork(
          apiPool,
          manager,
          String(ingestion.ingestionId),
        );
        expect(preRestartBacklog.pending).toBeGreaterThanOrEqual(1);
        const recoveryStartedAt = performance.now();
        activityWorker = new ActivityWorkerService(
          workerRepository,
          new ActivityRetentionRepository(workerPool),
          workerPool,
        );
        await activityWorker.onModuleInit();
        const qsoJobCompleted = await waitForJob(
          activity,
          String(ingestion.ingestionId),
          sampleBacklog,
        );
        const workerRestartRecoveryMilliseconds = Math.round(
          performance.now() - recoveryStartedAt,
        );
        const broadAwardJob = await broadAwardJobId(
          apiPool,
          programmeSlug,
          targetQsoCount,
        );
        const broadAwardCompleted = await waitForJob(
          activity,
          broadAwardJob,
          sampleBacklog,
        );
        const awardProgress = await apiPool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM activity_award_progress
           WHERE award_id=$1 AND category='HUNTER'`,
          [hunterAwardId],
        );
        expect(Number(awardProgress.rows[0]?.count)).toBe(targetQsoCount);

        const syncQsoDurations: number[] = [];
        for (let index = 0; index < 20; index++) {
          const startedAt = performance.now();
          await activityService.addQso(
            apiAuthorization,
            undefined,
            activationId,
            {
              workedCallsign: `SYNC${String(index).padStart(3, '0')}`,
              timestamp: `2026-01-03T00:00:${String(index).padStart(2, '0')}Z`,
              band: '20M',
              mode: 'SSB',
            },
          );
          syncQsoDurations.push(performance.now() - startedAt);
        }

        const awardsToken = (subjectId: string) =>
          `Bearer ${signAccessToken(subjectId, ['awards.request'])}`;
        const awardRequestDurations: number[] = [];
        for (let index = 0; index < 100; index++) {
          const number = String(index).padStart(5, '0');
          const subjectId = `${idPrefix}${number}`;
          const startedAt = performance.now();
          await awardsService.requestAward(awardsToken(subjectId), {
            awardId: hunterAwardId,
            levelId: 'participant',
            subjectId,
            callsign: `H${number}`,
            personName: 'Capacity qualification',
          });
          awardRequestDurations.push(performance.now() - startedAt);
        }

        await waitForRunJobs(apiPool, programmeSlug, sampleBacklog);
        await sampleBacklog();
        const dbAfter = await databaseStats(apiPool);
        const pendingOutbox = await apiPool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM outbox_event
           WHERE producer='activity-service' AND occurred_at >= $1
             AND published_at IS NULL`,
          [runStartedAt],
        );
        const finalJobMetrics = await apiPool.query<{
          kind: string;
          count: string;
          max_latency_ms: string;
          max_processing_ms: string;
        }>(
          `SELECT kind,count(*)::text AS count,
             max(EXTRACT(EPOCH FROM (completed_at-created_at))*1000)::text AS max_latency_ms,
             max(EXTRACT(EPOCH FROM (completed_at-started_at))*1000)::text AS max_processing_ms
           FROM activity_job
           WHERE payload->>'programmeSlug'=$1 AND status='SUCCEEDED'
           GROUP BY kind ORDER BY kind`,
          [programmeSlug],
        );
        await sampleBacklog();
        const rssAfterBytes = process.resourceUsage().maxRSS * 1024;
        const qsoCount = await apiPool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM activity_qso WHERE activation_id=$1`,
          [activationId],
        );
        expect(Number(qsoCount.rows[0]?.count)).toBeGreaterThanOrEqual(
          targetQsoCount * 2,
        );
        expect(Number(pendingOutbox.rows[0]?.count)).toBe(0);

        console.info(
          JSON.stringify({
            qualification: 'activity-capacity',
            measuredAt: new Date().toISOString(),
            environment: {
              node: process.version,
              ...resourceLimits,
              enforcedCpuLimitCores,
              enforcedMemoryLimitBytes,
              activityDatabasePoolMaximum: databasePoolMaximum,
              workerDatabasePoolMaximum: databasePoolMaximum,
              outboxDatabasePoolMaximum: databasePoolMaximum,
              activityWorkerReplicas: 1,
              activityApiReplicas: 2,
              activityWorkMaxAckPending: {
                qsoIngestion: 4,
                awardRecalculation: 2,
              },
            },
            adif: {
              sourceBytes: adifContent.byteLength,
              qsoCount: targetQsoCount,
              apiAdmissionMilliseconds: Math.round(adifAdmissionMs),
              apiAndWorkerJobLatencyMilliseconds:
                adifCompleted.latencyMilliseconds,
              workerProcessingMilliseconds:
                adifCompleted.processingMilliseconds,
              awardRecalculationLatencyMilliseconds:
                adifAwardCompleted.latencyMilliseconds,
              awardRecalculationProcessingMilliseconds:
                adifAwardCompleted.processingMilliseconds,
            },
            qsoIngestion: {
              qsoCount: targetQsoCount,
              apiAdmissionMilliseconds: Math.round(qsoAdmissionMs),
              apiAndWorkerJobLatencyMilliseconds:
                qsoJobCompleted.latencyMilliseconds,
              workerProcessingMilliseconds:
                qsoJobCompleted.processingMilliseconds,
              broadAwardSubjectCount: targetQsoCount,
              broadAwardLatencyMilliseconds:
                broadAwardCompleted.latencyMilliseconds,
              broadAwardProcessingMilliseconds:
                broadAwardCompleted.processingMilliseconds,
              storedProgressRows: Number(awardProgress.rows[0]?.count),
              workerRestartRecoveryMilliseconds,
              queuedJobsAtWorkerRestart: preRestartBacklog.pending,
              ackPendingAtWorkerRestart: preRestartBacklog.ackPending,
            },
            synchronous: {
              individualQsoWrites: percentileSummary(syncQsoDurations),
              awardRequests: percentileSummary(awardRequestDurations),
            },
            database: {
              statsDelta: databaseStatsDelta(dbBefore, dbAfter),
              peakActiveConnections: maxBacklog.activeDatabaseConnections,
              pendingOutboxEventsAtFinish: Number(pendingOutbox.rows[0]?.count),
            },
            jetstream: maxBacklog,
            workerJobs: finalJobMetrics.rows.map((row) => ({
              kind: row.kind,
              count: Number(row.count),
              maxLatencyMilliseconds: Math.round(
                Number(row.max_latency_ms ?? 0),
              ),
              maxProcessingMilliseconds: Math.round(
                Number(row.max_processing_ms ?? 0),
              ),
            })),
            peakProcessRssGrowthBytes: Math.max(
              0,
              rssAfterBytes - rssBeforeBytes,
            ),
          }),
        );
      } finally {
        clearInterval(sampler);
        s3Mock?.mockRestore();
        try {
          await outboxWorker?.onModuleDestroy().catch(() => undefined);
          await activityWorker?.onModuleDestroy().catch(() => undefined);
          await monitorConnection.drain().catch(() => undefined);
          if (activationId)
            await removeCapacityFixtures(
              apiPool,
              activationId,
              programmeSlug,
              idPrefix,
              operatorId,
              runStartedAt,
            );
        } finally {
          await Promise.all([
            apiPool.end(),
            workerPool.end(),
            outboxPool.end(),
          ]);
          if (authKey === undefined) delete process.env.MYOTA_AUTH_SIGNING_KEY;
          else process.env.MYOTA_AUTH_SIGNING_KEY = authKey;
          if (environment === undefined) delete process.env.MYOTA_ENV;
          else process.env.MYOTA_ENV = environment;
          if (uploadLimit === undefined)
            delete process.env.MYOTA_UPLOAD_MAX_BYTES;
          else process.env.MYOTA_UPLOAD_MAX_BYTES = uploadLimit;
          if (clamavUrl === undefined) delete process.env.MYOTA_CLAMAV_URL;
          else process.env.MYOTA_CLAMAV_URL = clamavUrl;
        }
      }
    },
    30 * 60 * 1000,
  );
});

async function waitForJob(
  repository: ActivityRepository,
  jobId: string,
  sample: () => Promise<void>,
) {
  const startedAt = performance.now();
  const timeoutAt = Date.now() + 15 * 60 * 1000;
  while (Date.now() < timeoutAt) {
    const job = await repository.getJob(jobId);
    await sample();
    if (job.status === 'SUCCEEDED') {
      return {
        latencyMilliseconds: Math.round(
          new Date(String(job.completedAt)).getTime() -
            new Date(String(job.createdAt)).getTime(),
        ),
        processingMilliseconds: Math.round(
          new Date(String(job.completedAt)).getTime() -
            new Date(String(job.startedAt)).getTime(),
        ),
        observedMilliseconds: Math.round(performance.now() - startedAt),
      };
    }
    if (job.status === 'FAILED')
      throw new Error(`capacity job ${jobId} failed: ${String(job.lastError)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for Activity job ${jobId}`);
}

async function waitForRunJobs(
  pool: Pool,
  programmeSlug: string,
  sample: () => Promise<void>,
) {
  const timeoutAt = Date.now() + 5 * 60 * 1000;
  while (Date.now() < timeoutAt) {
    const result = await pool.query<{ count: string; failed: string }>(
      `SELECT count(*) FILTER (WHERE status IN ('QUEUED','RUNNING'))::text AS count,
         count(*) FILTER (WHERE status='FAILED')::text AS failed
       FROM activity_job WHERE payload->>'programmeSlug'=$1`,
      [programmeSlug],
    );
    if (Number(result.rows[0]?.failed ?? 0) > 0)
      throw new Error('one or more Activity capacity jobs failed');
    if (Number(result.rows[0]?.count ?? 0) === 0) return;
    await sample();
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('timed out waiting for all Activity capacity jobs');
}

async function waitForPublishedWork(
  pool: Pool,
  manager: Awaited<ReturnType<typeof jetstreamManager>>,
  jobId: string,
) {
  const timeoutAt = Date.now() + 30_000;
  while (Date.now() < timeoutAt) {
    const [event, consumer] = await Promise.all([
      pool.query<{ published_at: Date | null }>(
        `SELECT published_at FROM outbox_event
         WHERE aggregate_type='activity_job' AND aggregate_id=$1
         ORDER BY occurred_at DESC LIMIT 1`,
        [jobId],
      ),
      manager.consumers.info('MYOTA_ACTIVITY_WORK', qsoDurable),
    ]);
    if (event.rows[0]?.published_at && Number(consumer.num_pending) >= 1) {
      return {
        pending: Number(consumer.num_pending),
        ackPending: Number(consumer.num_ack_pending),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    'Activity qualification work did not queue while its worker was stopped',
  );
}

async function jobIdForImport(pool: Pool, importId: string) {
  const result = await pool.query<{ id: string }>(
    `SELECT id::text AS id FROM activity_job
     WHERE kind='ADIF_IMPORT' AND payload->>'importId'=$1`,
    [importId],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('ADIF upload did not create a worker job');
  return id;
}

async function oldestQueuedAwardJob(pool: Pool, programmeSlug: string) {
  const result = await pool.query<{ id: string }>(
    `SELECT id::text AS id FROM activity_job
     WHERE kind='AWARD_RECALCULATE' AND status<>'FAILED'
       AND payload->>'programmeSlug'=$1
     ORDER BY created_at,id LIMIT 1`,
    [programmeSlug],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('ADIF upload did not queue award recalculation');
  return id;
}

async function broadAwardJobId(
  pool: Pool,
  programmeSlug: string,
  subjectCount: number,
) {
  const result = await pool.query<{ id: string }>(
    `SELECT id::text AS id FROM activity_job
     WHERE kind='AWARD_RECALCULATE' AND status<>'FAILED'
       AND payload->>'programmeSlug'=$1
       AND jsonb_array_length(payload->'subjectIds') >= $2
     ORDER BY created_at DESC,id DESC LIMIT 1`,
    [programmeSlug, subjectCount],
  );
  const id = result.rows[0]?.id;
  if (!id)
    throw new Error('QSO ingestion did not queue broad award recalculation');
  return id;
}

async function databaseStats(pool: Pool): Promise<DatabaseStats> {
  const result = await pool.query<DatabaseStats>(
    `SELECT xact_commit::text,tup_inserted::text,tup_updated::text,
       blks_read::text,blks_hit::text,temp_bytes::text
     FROM pg_stat_database WHERE datname=current_database()`,
  );
  const stats = result.rows[0];
  if (!stats) throw new Error('PostgreSQL did not return database statistics');
  return stats;
}

function databaseStatsDelta(before: DatabaseStats, after: DatabaseStats) {
  return Object.fromEntries(
    Object.keys(before).map((key) => [
      key,
      Number(after[key as keyof DatabaseStats]) -
        Number(before[key as keyof DatabaseStats]),
    ]),
  );
}

function percentileSummary(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50Milliseconds: Math.round(percentile(sorted, 0.5)),
    p95Milliseconds: Math.round(percentile(sorted, 0.95)),
    maxMilliseconds: Math.round(sorted.at(-1) ?? 0),
  };
}

function percentile(values: number[], quantile: number) {
  if (!values.length) return 0;
  return (
    values[
      Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1)
    ] ?? 0
  );
}

function maximumAdifDocument(qsoCount: number) {
  const records = Array.from({ length: qsoCount }, (_, index) => {
    const callsign = `W${String(index).padStart(5, '0')}`;
    const secondsSinceMidnight = index % 86_400;
    const timeOn = [
      Math.floor(secondsSinceMidnight / 3_600),
      Math.floor((secondsSinceMidnight % 3_600) / 60),
      secondsSinceMidnight % 60,
    ]
      .map((part) => String(part).padStart(2, '0'))
      .join('');
    return `<CALL:${callsign.length}>${callsign}<QSO_DATE:8>20260102<TIME_ON:6>${timeOn}<BAND:3>20M<MODE:3>SSB<EOR>\n`;
  }).join('');
  const prefix = '<ADIF_VER:5>3.1.0<EOH>\n';
  const content = `${prefix}${records}`;
  const paddingLength = adifUploadLimitBytes - Buffer.byteLength(content);
  if (paddingLength < 0)
    throw new Error('ADIF records exceed the configured upload limit');
  return Buffer.from(`${content}${' '.repeat(paddingLength)}`);
}

async function removeCapacityFixtures(
  pool: Pool,
  activationId: string,
  programmeSlug: string,
  idPrefix: string,
  operatorId: string,
  runStartedAt: Date,
) {
  await pool.query('BEGIN');
  try {
    await pool.query(
      `DELETE FROM outbox_event WHERE producer='activity-service'
       AND occurred_at >= $1 AND (
         aggregate_id=$2 OR
         aggregate_id IN (SELECT id::text FROM activity_qso WHERE activation_id::text=$2) OR
         aggregate_id IN (SELECT id::text FROM activity_job WHERE payload->>'programmeSlug'=$3) OR
         aggregate_id IN (SELECT id::text FROM activity_import WHERE activation_id::text=$2) OR
         payload->>'subjectId' LIKE $4
       )`,
      [runStartedAt, activationId, programmeSlug, `${idPrefix}%`],
    );
    await pool.query(
      `DELETE FROM activity_notification WHERE recipient_id=$1 OR recipient_id LIKE $2`,
      [operatorId, `${idPrefix}%`],
    );
    await pool.query(
      `DELETE FROM activity_award_request WHERE programme_slug=$1`,
      [programmeSlug],
    );
    await pool.query(
      `DELETE FROM activity_award_progress WHERE award_id IN
       (SELECT id FROM activity_award_definition WHERE programme_slug=$1)`,
      [programmeSlug],
    );
    await pool.query(
      `DELETE FROM activity_award_definition WHERE programme_slug=$1`,
      [programmeSlug],
    );
    await pool.query(
      `DELETE FROM activity_job WHERE payload->>'programmeSlug'=$1`,
      [programmeSlug],
    );
    await pool.query(`DELETE FROM activity_import WHERE activation_id=$1`, [
      activationId,
    ]);
    await pool.query(`DELETE FROM activity_qso WHERE activation_id=$1`, [
      activationId,
    ]);
    await pool.query(
      `DELETE FROM activity_subject_callsign WHERE programme_slug=$1`,
      [programmeSlug],
    );
    await pool.query(
      `DELETE FROM activity_subject_entity WHERE programme_slug=$1`,
      [programmeSlug],
    );
    await pool.query(
      `DELETE FROM activity_subject_aggregate WHERE programme_slug=$1`,
      [programmeSlug],
    );
    await pool.query(`DELETE FROM activity_activation WHERE id=$1`, [
      activationId,
    ]);
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

function assertLocalActivityDatabase(connectionString: string) {
  const url = new URL(connectionString);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    databaseName !== 'myota_activity'
  ) {
    throw new Error(
      'Activity capacity qualification only runs against loopback myota_activity',
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
