import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { stringifyJsonWithBigInts } from '../../../libs/platform/src/json-bigint.js';
import { ActivityWorkRepository } from './activity-work.repository.js';

const recoveryCases = [
  {
    kind: 'STATISTICS_REBUILD',
    testName: 'reclaims a statistics rebuild after worker process death',
  },
  {
    kind: 'AWARD_RECALCULATE',
    testName: 'reclaims award recalculation after worker process death',
  },
  {
    kind: 'AWARD_EVALUATION',
    testName: 'reclaims direct award evaluation after worker process death',
  },
  {
    kind: 'QSO_INGESTION',
    testName: 'reclaims QSO ingestion after worker process death',
  },
  {
    kind: 'ADIF_IMPORT',
    testName: 'reclaims an interrupted ADIF import after worker process death',
  },
  {
    kind: 'PDF_RENDER',
    testName: 'reclaims a certificate render after worker process death',
  },
];

describe('Activity worker process recovery', () => {
  for (const recoveryCase of recoveryCases) {
    it.skipIf(
      process.env.MYOTA_ACTIVITY_WORKER_RECOVERY_TEST !== '1' ||
        !process.env.ACTIVITY_DATABASE_URL,
    )(
      recoveryCase.testName,
      async () => {
        if (process.env.MYOTA_ACTIVITY_WORKER_RECOVERY_PHASE) {
          await runInterruptedWorkerPhase();
          return;
        }
        await verifyWorkerRecovery(recoveryCase.kind, recoveryCase.testName);
      },
      120_000,
    );
  }
});

async function runInterruptedWorkerPhase() {
  const databaseUrl = process.env.ACTIVITY_DATABASE_URL;
  const jobId = process.env.MYOTA_ACTIVITY_WORKER_RECOVERY_JOB_ID;
  const jobKind = process.env.MYOTA_ACTIVITY_WORKER_RECOVERY_JOB_KIND;
  if (!databaseUrl || !jobId)
    throw new Error('Activity worker recovery phase is missing its settings');

  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const job = await new ActivityWorkRepository(pool).claimWorkJob(
      jobId,
      jobKind ?? 'STATISTICS_REBUILD',
      120,
    );
    if (!job) throw new Error('Activity worker could not claim the fixture');
    if (process.env.MYOTA_ACTIVITY_WORKER_RECOVERY_PHASE === 'process') {
      await new ActivityWorkRepository(pool).process(job);
      return;
    }
    await new Promise<void>(() => setInterval(() => undefined, 1000));
  } finally {
    await pool.end();
  }
}

async function verifyWorkerRecovery(jobKind: string, testName: string) {
  const databaseUrl = process.env.ACTIVITY_DATABASE_URL;
  if (!databaseUrl) throw new Error('ACTIVITY_DATABASE_URL is required');
  const database = new URL(databaseUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(database.hostname))
    throw new Error('Activity recovery qualification requires local Postgres');

  const pool = new Pool({ connectionString: databaseUrl, max: 3 });
  const jobId = randomUUID();
  const programmeSlug = `worker-recovery-${jobId}`;
  const activationId =
    jobKind === 'QSO_INGESTION' || jobKind === 'ADIF_IMPORT'
      ? randomUUID()
      : undefined;
  const awardId =
    jobKind === 'AWARD_RECALCULATE' ||
    jobKind === 'AWARD_EVALUATION' ||
    jobKind === 'PDF_RENDER'
      ? randomUUID()
      : undefined;
  const importId = jobKind === 'ADIF_IMPORT' ? randomUUID() : undefined;
  const requestId = jobKind === 'PDF_RENDER' ? randomUUID() : undefined;
  const issuanceId = jobKind === 'PDF_RENDER' ? randomUUID() : undefined;
  const subjectId = `worker-recovery-subject-${jobId}`;
  const previousObjectStorageEndpoint =
    process.env.MYOTA_OBJECT_STORAGE_ENDPOINT;
  const previousObjectStorageAddressingStyle =
    process.env.MYOTA_OBJECT_STORAGE_ADDRESSING_STYLE;
  let objectStore: RecoveryObjectStore | undefined;
  const interruptDuringProcessing =
    jobKind === 'STATISTICS_REBUILD' ||
    jobKind === 'AWARD_EVALUATION' ||
    jobKind === 'QSO_INGESTION' ||
    jobKind === 'ADIF_IMPORT' ||
    jobKind === 'AWARD_RECALCULATE' ||
    jobKind === 'PDF_RENDER';
  const workerEnvironment = {
    ...process.env,
    ACTIVITY_DATABASE_URL: databaseUrl,
    MYOTA_ACTIVITY_WORKER_RECOVERY_TEST: '1',
    MYOTA_ACTIVITY_WORKER_RECOVERY_PHASE: interruptDuringProcessing
      ? 'process'
      : 'interrupt',
    MYOTA_ACTIVITY_WORKER_RECOVERY_JOB_ID: jobId,
    MYOTA_ACTIVITY_WORKER_RECOVERY_JOB_KIND: jobKind,
    MYOTA_ACTIVITY_WORKER_RECOVERY_TEST_NAME: testName,
  };
  let worker: ReturnType<typeof spawnRecoveryWorker> | undefined;
  let sideEffectBlocker: SideEffectBlocker | undefined;
  let blockedBackendPid: number | undefined;
  let blockerClient: PoolClient | undefined;

  try {
    if (importId || issuanceId) {
      objectStore = await startRecoveryObjectStore(jobKind === 'PDF_RENDER');
      process.env.MYOTA_OBJECT_STORAGE_ENDPOINT = objectStore.endpoint;
      process.env.MYOTA_OBJECT_STORAGE_ADDRESSING_STYLE = 'path';
      workerEnvironment.MYOTA_OBJECT_STORAGE_ENDPOINT = objectStore.endpoint;
      workerEnvironment.MYOTA_OBJECT_STORAGE_ADDRESSING_STYLE = 'path';
    }
    if (activationId) {
      await pool.query(
        `INSERT INTO activity_activation
           (id,programme_slug,entity_id,entity_type,operator_id,operator_callsign,started_at)
         VALUES ($1,$2,'recovery-entity','SOTA','worker-recovery-operator','N0CALL','2026-01-01T00:00:00Z')`,
        [activationId, programmeSlug],
      );
    }
    if (awardId) {
      const definition = {
        id: awardId,
        programmeSlug,
        code: `RECOVERY-${jobId.slice(0, 8)}`,
        name: 'Worker recovery award',
        category: 'ACTIVATOR',
        version: 1,
        achievementMetric: 'QSO_COUNT',
        condition: { kind: 'QSO_COUNT', operator: 'GTE', value: 5 },
        levels: [{ id: 'level-5', name: 'Five QSOs', threshold: 5 }],
      };
      await pool.query(
        `INSERT INTO activity_award_definition
           (id,programme_slug,code,version,status,definition)
         VALUES ($1,$2,$3,1,'PUBLISHED',$4::jsonb)`,
        [
          awardId,
          programmeSlug,
          definition.code,
          stringifyJsonWithBigInts(definition),
        ],
      );
      if (jobKind === 'AWARD_RECALCULATE' || jobKind === 'AWARD_EVALUATION')
        await pool.query(
          `INSERT INTO activity_subject_aggregate
             (programme_slug,subject_id,category,qso_count,activation_count)
           VALUES ($1,$2,'ACTIVATOR',7,1)`,
          [programmeSlug, subjectId],
        );
    }
    if (importId && activationId && objectStore) {
      const content = adifRecoveryContent();
      objectStore.objects.set(
        objectStoreKey('recovery-adif', `activity/${importId}.adi`),
        content,
      );
      await pool.query(
        `INSERT INTO activity_import
           (id,activation_id,filename,object_key,bucket,sha256,content_size,malware_status)
         VALUES ($1,$2,'recovery.adi',$3,'recovery-adif',$4,$5,'CLEAN')`,
        [
          importId,
          activationId,
          `activity/${importId}.adi`,
          createHash('sha256').update(content).digest('hex'),
          content.length,
        ],
      );
    }
    if (awardId && requestId && issuanceId && objectStore) {
      const image = await readFile(
        'apps/identity/src/fixtures/profile-image-rgba.png',
      );
      const backgroundKey = `activity/${issuanceId}-background.png`;
      const signatureKey = `activity/${issuanceId}-signature.png`;
      objectStore.objects.set(
        objectStoreKey('recovery-awards', backgroundKey),
        image,
      );
      objectStore.objects.set(
        objectStoreKey('recovery-awards', signatureKey),
        image,
      );
      const artifactKey = `rendered/${issuanceId}.pdf`;
      objectStore.artifactKey = objectStoreKey('recovery-awards', artifactKey);
      const issuance = {
        id: issuanceId,
        awardId,
        awardName: 'Worker recovery award',
        callsign: 'N0CALL',
        personName: 'Worker Recovery',
        dateObtained: '2026-01-01',
        managerName: 'MyOTA',
        renderSpec: {
          backgroundAsset: {
            bucket: 'recovery-awards',
            objectKey: backgroundKey,
          },
          signatureAsset: {
            bucket: 'recovery-awards',
            objectKey: signatureKey,
          },
          printSpec: { page: 'A4', orientation: 'PORTRAIT' },
          elements: [],
        },
        artifact: { bucket: 'recovery-awards', objectKey: artifactKey },
      };
      await pool.query(
        `INSERT INTO activity_award_request
           (id,award_id,programme_slug,level_id,subject_id,category,callsign,person_name)
         VALUES ($1,$2,$3,'level-5',$4,'ACTIVATOR','N0CALL','Worker Recovery')`,
        [requestId, awardId, programmeSlug, subjectId],
      );
      await pool.query(
        `INSERT INTO activity_award_issuance
           (id,request_id,award_id,programme_slug,level_id,subject_id,issuance)
         VALUES ($1,$2,$3,$4,'level-5',$5,$6::jsonb)`,
        [
          issuanceId,
          requestId,
          awardId,
          programmeSlug,
          subjectId,
          stringifyJsonWithBigInts(issuance),
        ],
      );
    }
    await pool.query(
      `INSERT INTO activity_job(id,kind,payload)
       VALUES ($1,$2,$3::jsonb)`,
      [
        jobId,
        jobKind,
        stringifyJsonWithBigInts(
          jobKind === 'STATISTICS_REBUILD'
            ? { programmeSlug }
            : jobKind === 'AWARD_RECALCULATE'
              ? { programmeSlug, subjectIds: [subjectId] }
              : jobKind === 'AWARD_EVALUATION'
                ? { awardId, subjectId }
                : jobKind === 'ADIF_IMPORT'
                  ? { importId }
                  : jobKind === 'PDF_RENDER'
                    ? { issuanceId }
                    : {
                        activationId,
                        records: [
                          {
                            workedCallsign: 'K1RECOVERY',
                            timestamp: '2026-01-01T00:05:00Z',
                            band: '20M',
                            mode: 'SSB',
                          },
                        ],
                      },
        ),
      ],
    );

    if (interruptDuringProcessing && jobKind !== 'PDF_RENDER') {
      const targetId =
        jobKind === 'STATISTICS_REBUILD'
          ? programmeSlug
          : jobKind === 'QSO_INGESTION'
            ? activationId
            : jobKind === 'ADIF_IMPORT'
              ? importId
              : awardId;
      if (!targetId)
        throw new Error(
          `${jobKind} recovery fixture has no side-effect target`,
        );
      sideEffectBlocker = await installSideEffectBlocker(
        pool,
        jobKind,
        targetId,
      );
      blockerClient = await pool.connect();
      await blockerClient.query('SELECT pg_advisory_lock(4815162342)');
    }

    worker = spawnRecoveryWorker(workerEnvironment);
    await waitForClaim(worker, pool, jobId);
    if (jobKind === 'PDF_RENDER' && objectStore)
      await waitForArtifactWrite(worker, objectStore);
    else if (sideEffectBlocker)
      blockedBackendPid = await waitForBlockedSideEffect(
        worker,
        pool,
        sideEffectBlocker,
      );
    killRecoveryWorker(worker);
    await waitForExit(worker);
    objectStore?.releaseArtifactWrite();
    if (blockerClient) {
      if (blockedBackendPid !== undefined)
        await waitForDatabaseBackendExit(pool, blockedBackendPid);
      await blockerClient.query('SELECT pg_advisory_unlock(4815162342)');
      blockerClient.release();
      blockerClient = undefined;
    }
    if (interruptDuringProcessing)
      await expectRolledBackSideEffects(
        pool,
        jobKind,
        activationId,
        importId,
        awardId,
        subjectId,
        programmeSlug,
        issuanceId,
        objectStore,
      );

    const expiredLease = await pool.query<{
      status: string;
      attempts: number;
      available_at: Date;
      lease_expires_at: Date | null;
    }>(
      `UPDATE activity_job SET available_at=now(),
         lease_expires_at=now()-interval '1 second'
       WHERE id=$1
       RETURNING status,attempts,available_at,lease_expires_at`,
      [jobId],
    );
    expect(expiredLease.rows).toHaveLength(1);
    expect(expiredLease.rows[0]).toMatchObject({
      status: 'RUNNING',
      attempts: 1,
    });
    const repository = new ActivityWorkRepository(pool);
    const recovered = await repository.claimWorkJob(jobId, jobKind, 120);
    expect(
      recovered,
      `Activity job was not reclaimable after process death: ${JSON.stringify(expiredLease.rows[0])}`,
    ).toMatchObject({ id: jobId, attempts: 2 });
    if (!recovered) throw new Error('Activity job lease was not reclaimed');
    if (
      (jobKind === 'ADIF_IMPORT' || jobKind === 'PDF_RENDER') &&
      objectStore
    ) {
      objectStore.available = false;
      let storageError: unknown;
      try {
        await repository.process(recovered);
      } catch (error) {
        storageError = error;
      }
      expect(storageError).toBeDefined();
      if (jobKind === 'ADIF_IMPORT') {
        const interrupted = await pool.query<{
          job_status: string;
          attempts: number;
          import_status: string;
          imported_qsos: number;
          failed_notifications: number;
        }>(
          `SELECT job.status AS job_status,job.attempts,import.status AS import_status,
             (SELECT count(*)::int FROM activity_qso WHERE source_import_id=import.id) AS imported_qsos,
             (SELECT count(*)::int FROM activity_notification
              WHERE deduplication_key='adif:' || import.id::text || ':failed') AS failed_notifications
           FROM activity_job job JOIN activity_import import ON import.id=$2
           WHERE job.id=$1`,
          [jobId, importId],
        );
        expect(interrupted.rows[0]).toMatchObject({
          job_status: 'RUNNING',
          attempts: 2,
          import_status: 'PROCESSING',
          imported_qsos: 0,
          failed_notifications: 0,
        });
      } else {
        const existingArtifact = objectStore.objects.get(
          objectStore.artifactKey ?? '',
        );
        expect(existingArtifact?.toString('ascii', 0, 4)).toBe('%PDF');
        const interrupted = await pool.query<{
          job_status: string;
          attempts: number;
          issuance: string;
          render_events: number;
        }>(
          `SELECT job.status AS job_status,job.attempts,issuance.issuance::text AS issuance,
             (SELECT count(*)::int FROM outbox_event
              WHERE aggregate_type='award_issuance' AND aggregate_id=issuance.id::text) AS render_events
           FROM activity_job job JOIN activity_award_issuance issuance ON issuance.id=$2
           WHERE job.id=$1`,
          [jobId, issuanceId],
        );
        expect(interrupted.rows[0]).toMatchObject({
          job_status: 'RUNNING',
          attempts: 2,
          render_events: 0,
        });
        expect(
          JSON.parse(interrupted.rows[0]!.issuance).artifact,
        ).not.toMatchObject({
          downloadReady: true,
          renderStatus: 'READY',
        });
        expect(objectStore.objects.get(objectStore.artifactKey ?? '')).toEqual(
          existingArtifact,
        );
      }
      await repository.retryWorkJob(recovered, storageError, 0);
      objectStore.available = true;
      const retried = await repository.claimWorkJob(jobId, jobKind, 120);
      expect(retried).toMatchObject({ id: jobId, attempts: 3 });
      if (!retried) throw new Error('Activity retry was not reclaimable');
      await repository.process(retried);
    } else {
      await repository.process(recovered);
    }

    if (jobKind === 'STATISTICS_REBUILD') {
      const result = await pool.query(
        `SELECT job.status,job.attempts,count(snapshot.id)::int AS snapshots
         FROM activity_job job LEFT JOIN activity_statistic_snapshot snapshot
           ON snapshot.programme_slug=$2 AND snapshot.algorithm_version='activity-v2'
         WHERE job.id=$1 GROUP BY job.id`,
        [jobId, programmeSlug],
      );
      expect(result.rows[0]).toMatchObject({
        status: 'SUCCEEDED',
        attempts: 2,
        snapshots: 2,
      });
    } else if (
      jobKind === 'AWARD_RECALCULATE' ||
      jobKind === 'AWARD_EVALUATION'
    ) {
      const result = await pool.query(
        `SELECT job.status,job.attempts,progress.evaluation,
                (SELECT count(*)::int FROM activity_notification notification
                 WHERE notification.recipient_id=$3
                   AND notification.deduplication_key LIKE $4) AS notifications
         FROM activity_job job LEFT JOIN activity_award_progress progress
           ON progress.award_id=$2 AND progress.award_version=1
             AND progress.subject_id=$3
         WHERE job.id=$1`,
        [
          jobId,
          awardId,
          subjectId,
          `award-qualified:${awardId}:1:${subjectId}%`,
        ],
      );
      expect(result.rows[0]).toMatchObject({
        status: 'SUCCEEDED',
        attempts: 2,
        notifications: 1,
        evaluation: {
          conditionMet: true,
          metric: 'QSO_COUNT',
          progress: 7,
          levels: [{ id: 'level-5', eligible: true }],
        },
      });
    } else if (jobKind === 'QSO_INGESTION') {
      const result = await pool.query(
        `SELECT job.status,job.attempts,activation.qso_count,
                count(DISTINCT qso.id)::int AS qsos,
                aggregate.qso_count::int AS operator_qsos,
                count(DISTINCT event.event_id)::int AS qso_events,
                count(DISTINCT downstream.id)::int AS award_jobs
         FROM activity_job job
         JOIN activity_activation activation ON activation.id=$2
         LEFT JOIN activity_qso qso ON qso.activation_id=activation.id
         LEFT JOIN activity_subject_aggregate aggregate
           ON aggregate.programme_slug=activation.programme_slug
             AND aggregate.subject_id=activation.operator_id
             AND aggregate.category='ACTIVATOR'
         LEFT JOIN outbox_event event
           ON event.aggregate_type='qso' AND event.aggregate_id=qso.id::text
         LEFT JOIN activity_job downstream
           ON downstream.idempotency_key LIKE 'batch:' || activation.id::text || ':%'
             AND downstream.kind='AWARD_RECALCULATE'
         WHERE job.id=$1 GROUP BY job.id,activation.id,aggregate.qso_count`,
        [jobId, activationId],
      );
      expect(result.rows[0]).toMatchObject({
        status: 'SUCCEEDED',
        attempts: 2,
        qso_count: 1,
        qsos: 1,
        operator_qsos: 1,
        qso_events: 1,
        award_jobs: 1,
      });
    } else if (jobKind === 'ADIF_IMPORT') {
      const result = await pool.query(
        `SELECT job.status,job.attempts,import.status AS import_status,
                import.records_seen,import.records_accepted,import.records_rejected,
                count(DISTINCT qso.id)::int AS qsos,
                count(DISTINCT event.event_id)::int AS qso_events,
                count(DISTINCT notification.id)::int AS notifications
         FROM activity_job job
         JOIN activity_import import ON import.id=$2
         LEFT JOIN activity_qso qso ON qso.source_import_id=import.id
         LEFT JOIN outbox_event event
           ON event.aggregate_type='qso' AND event.aggregate_id=qso.id::text
         LEFT JOIN activity_notification notification
           ON notification.deduplication_key='adif:' || import.id::text || ':completed'
         WHERE job.id=$1 GROUP BY job.id,import.id`,
        [jobId, importId],
      );
      expect(result.rows[0]).toMatchObject({
        status: 'SUCCEEDED',
        attempts: 3,
        import_status: 'COMPLETED',
        records_seen: 1,
        records_accepted: 1,
        records_rejected: 0,
        qsos: 1,
        qso_events: 1,
        notifications: 1,
      });
    } else {
      const result = await pool.query<{
        status: string;
        attempts: number;
        issuance: string;
        render_events: number;
      }>(
        `SELECT job.status,job.attempts,issuance.issuance::text AS issuance,
                (SELECT count(*)::int FROM outbox_event
                 WHERE aggregate_type='award_issuance'
                   AND aggregate_id=issuance.id::text) AS render_events
         FROM activity_job job
         JOIN activity_award_issuance issuance ON issuance.id=$2
         WHERE job.id=$1`,
        [jobId, issuanceId],
      );
      expect(result.rows[0]).toMatchObject({
        status: 'SUCCEEDED',
        attempts: 3,
        render_events: 1,
      });
      const storedIssuance = JSON.parse(result.rows[0]!.issuance);
      expect(storedIssuance.artifact).toMatchObject({
        downloadReady: true,
        renderStatus: 'READY',
      });
      expect(storedIssuance.artifact.contentSha256).toMatch(/^[0-9a-f]{64}$/);
      const renderedArtifact = objectStore?.objects.get(
        objectStore.artifactKey ?? '',
      );
      expect(renderedArtifact?.toString('ascii', 0, 4)).toBe('%PDF');
      expect(createHash('sha256').update(renderedArtifact!).digest('hex')).toBe(
        storedIssuance.artifact.contentSha256,
      );
    }
  } finally {
    if (worker && worker.exitCode === null) {
      killRecoveryWorker(worker);
      await waitForExit(worker).catch(() => undefined);
    }
    if (blockerClient) {
      await blockerClient
        .query('SELECT pg_advisory_unlock(4815162342)')
        .catch(() => undefined);
      blockerClient.release();
    }
    if (sideEffectBlocker)
      await removeSideEffectBlocker(pool, sideEffectBlocker);
    try {
      await cleanupRecoveryFixture(
        pool,
        jobId,
        programmeSlug,
        awardId,
        subjectId,
        activationId,
        importId,
        requestId,
        issuanceId,
      );
    } finally {
      if (objectStore) {
        objectStore.releaseArtifactWrite();
        await stopRecoveryObjectStore(objectStore);
      }
      if (previousObjectStorageEndpoint === undefined)
        delete process.env.MYOTA_OBJECT_STORAGE_ENDPOINT;
      else
        process.env.MYOTA_OBJECT_STORAGE_ENDPOINT =
          previousObjectStorageEndpoint;
      if (previousObjectStorageAddressingStyle === undefined)
        delete process.env.MYOTA_OBJECT_STORAGE_ADDRESSING_STYLE;
      else
        process.env.MYOTA_OBJECT_STORAGE_ADDRESSING_STYLE =
          previousObjectStorageAddressingStyle;
    }
  }
}

async function cleanupRecoveryFixture(
  pool: Pool,
  jobId: string,
  programmeSlug: string,
  awardId?: string,
  subjectId?: string,
  activationId?: string,
  importId?: string,
  requestId?: string,
  issuanceId?: string,
) {
  let cleanupError: unknown;
  try {
    await pool.query(
      `DELETE FROM activity_statistic_snapshot
       WHERE programme_slug=$1 AND algorithm_version='activity-v2'`,
      [programmeSlug],
    );
    if (awardId && subjectId) {
      if (issuanceId) {
        await pool.query(
          `DELETE FROM outbox_event WHERE aggregate_type='award_issuance'
           AND aggregate_id=$1`,
          [issuanceId],
        );
        await pool.query('DELETE FROM activity_award_issuance WHERE id=$1', [
          issuanceId,
        ]);
      }
      if (requestId)
        await pool.query('DELETE FROM activity_award_request WHERE id=$1', [
          requestId,
        ]);
      await pool.query(
        `DELETE FROM activity_notification
         WHERE deduplication_key LIKE $1`,
        [`award-qualified:${awardId}:1:${subjectId}%`],
      );
      await pool.query(
        'DELETE FROM activity_award_progress WHERE award_id=$1',
        [awardId],
      );
      await pool.query('DELETE FROM activity_award_definition WHERE id=$1', [
        awardId,
      ]);
      await pool.query(
        'DELETE FROM activity_subject_aggregate WHERE programme_slug=$1 AND subject_id=$2',
        [programmeSlug, subjectId],
      );
    }
    if (activationId) {
      await pool.query(
        `DELETE FROM outbox_event
         WHERE aggregate_type='qso' AND aggregate_id IN
           (SELECT id::text FROM activity_qso WHERE activation_id=$1)`,
        [activationId],
      );
      await pool.query(
        `DELETE FROM outbox_event
         WHERE aggregate_type='activity_job' AND aggregate_id IN
           (SELECT id::text FROM activity_job
            WHERE idempotency_key LIKE 'batch:' || $1::text || ':%')`,
        [activationId],
      );
      await pool.query(
        `DELETE FROM activity_job
         WHERE idempotency_key LIKE 'batch:' || $1::text || ':%'`,
        [activationId],
      );
      await pool.query(
        `DELETE FROM activity_subject_callsign
         WHERE programme_slug=$1 AND subject_id='worker-recovery-operator'`,
        [programmeSlug],
      );
      await pool.query(
        `DELETE FROM activity_subject_entity
         WHERE programme_slug=$1 AND subject_id='worker-recovery-operator'`,
        [programmeSlug],
      );
      await pool.query(
        `DELETE FROM activity_subject_aggregate
         WHERE programme_slug=$1 AND subject_id='worker-recovery-operator'`,
        [programmeSlug],
      );
      await pool.query('DELETE FROM activity_qso WHERE activation_id=$1', [
        activationId,
      ]);
      if (importId) {
        await pool.query(
          `DELETE FROM activity_notification
           WHERE deduplication_key IN ($1,$2)`,
          [`adif:${importId}:completed`, `adif:${importId}:failed`],
        );
        await pool.query(
          `DELETE FROM outbox_event
           WHERE aggregate_type='activity_import' AND aggregate_id=$1`,
          [importId],
        );
        await pool.query('DELETE FROM activity_import WHERE id=$1', [importId]);
      }
      await pool.query('DELETE FROM activity_activation WHERE id=$1', [
        activationId,
      ]);
    }
    await pool.query(
      "DELETE FROM outbox_event WHERE aggregate_type='activity_job' AND aggregate_id=$1",
      [jobId],
    );
    await pool.query('DELETE FROM activity_job WHERE id=$1', [jobId]);
  } catch (error) {
    cleanupError = error;
  }
  await pool.end();
  if (cleanupError) throw cleanupError;
}

type RecoveryObjectStore = {
  endpoint: string;
  server: ReturnType<typeof createServer>;
  objects: Map<string, Buffer>;
  available: boolean;
  artifactKey?: string;
  artifactWriteObserved: boolean;
  releaseArtifactWrite(): void;
};

function adifRecoveryContent() {
  return Buffer.from(
    '<ADIF_VER:5>3.1.0<EOH>\n<CALL:8>K1RECOVR<QSO_DATE:8>20260101<TIME_ON:6>000500<BAND:3>20M<MODE:3>SSB<EOR>\n',
  );
}

function objectStoreKey(bucket: string, key: string) {
  return `/${bucket}/${key}`;
}

async function startRecoveryObjectStore(blockArtifactWrite = false) {
  const objects = new Map<string, Buffer>();
  let available = true;
  let artifactWriteObserved = false;
  let releaseArtifactWriteGate: () => void = () => undefined;
  const artifactWriteGate = new Promise<void>((resolve) => {
    releaseArtifactWriteGate = resolve;
  });
  const server = createServer((request, response) => {
    const key = decodeURIComponent(
      new URL(request.url ?? '/', 'http://127.0.0.1').pathname,
    );
    if (!available) {
      response.statusCode = 503;
      response.setHeader('content-type', 'application/xml');
      response.end(
        '<Error><Code>ServiceUnavailable</Code><Message>Temporary object-store outage</Message></Error>',
      );
      return;
    }
    if (request.method === 'GET') {
      const object = objects.get(key);
      response.statusCode = object ? 200 : 404;
      if (object) {
        response.setHeader('content-type', 'application/octet-stream');
        response.setHeader('content-length', object.length);
        response.end(object);
      } else {
        response.end('<Error><Code>NoSuchKey</Code></Error>');
      }
      return;
    }
    if (request.method === 'PUT') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer | Uint8Array) =>
        chunks.push(Buffer.from(chunk)),
      );
      request.on('end', () => {
        const body = Buffer.concat(chunks);
        void (async () => {
          objects.set(key, body);
          if (blockArtifactWrite && key === recoveryObjectStore.artifactKey) {
            artifactWriteObserved = true;
            await artifactWriteGate;
          }
          if (response.destroyed) return;
          response.statusCode = 200;
          response.setHeader(
            'ETag',
            `"${createHash('md5').update(body).digest('hex')}"`,
          );
          response.end();
        })();
      });
      return;
    }
    response.statusCode = 405;
    response.end();
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('could not start the Activity recovery object store'));
        return;
      }
      resolve(address.port);
    });
  });
  const recoveryObjectStore: RecoveryObjectStore = {
    endpoint: `http://127.0.0.1:${port}`,
    server,
    objects,
    get available() {
      return available;
    },
    set available(value: boolean) {
      available = value;
    },
    get artifactWriteObserved() {
      return artifactWriteObserved;
    },
    releaseArtifactWrite() {
      releaseArtifactWriteGate();
    },
  };
  return recoveryObjectStore;
}

async function stopRecoveryObjectStore(objectStore: RecoveryObjectStore) {
  await new Promise<void>((resolve, reject) =>
    objectStore.server.close((error) => (error ? reject(error) : resolve())),
  );
}

function spawnRecoveryWorker(environment: NodeJS.ProcessEnv) {
  const child = spawn(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      'apps/activity-worker/src/activity-worker-recovery.spec.ts',
      '-t',
      environment.MYOTA_ACTIVITY_WORKER_RECOVERY_TEST_NAME ??
        recoveryCases[0].testName,
      '--maxWorkers=1',
      '--no-file-parallelism',
      '--pool=threads',
    ],
    {
      detached: process.platform !== 'win32',
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  return Object.assign(child, { getOutput: () => output });
}

function killRecoveryWorker(worker: ReturnType<typeof spawnRecoveryWorker>) {
  if (process.platform !== 'win32' && worker.pid) {
    try {
      process.kill(-worker.pid, 'SIGKILL');
      return;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ESRCH'
      )
        throw error;
    }
  }
  if (worker.exitCode === null) worker.kill('SIGKILL');
}

async function waitForClaim(
  worker: ReturnType<typeof spawnRecoveryWorker>,
  pool: Pool,
  jobId: string,
) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (worker.exitCode !== null || worker.signalCode !== null)
      throw new Error(
        `Activity worker exited before claiming: ${worker.getOutput()}`,
      );
    const result = await pool.query(
      'SELECT status,attempts FROM activity_job WHERE id=$1',
      [jobId],
    );
    if (result.rows[0]?.status === 'RUNNING' && result.rows[0]?.attempts === 1)
      return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Activity worker did not claim the job: ${worker.getOutput()}`,
  );
}

type SideEffectBlocker = {
  table:
    'activity_qso' | 'activity_award_progress' | 'activity_statistic_snapshot';
  column: 'activation_id' | 'source_import_id' | 'award_id' | 'programme_slug';
  triggerName: string;
  functionName: string;
};

async function installSideEffectBlocker(
  pool: Pool,
  jobKind: string,
  targetId: string,
): Promise<SideEffectBlocker> {
  const suffix = randomUUID().replaceAll('-', '');
  const blocker =
    jobKind === 'STATISTICS_REBUILD'
      ? {
          table: 'activity_statistic_snapshot' as const,
          column: 'programme_slug' as const,
        }
      : jobKind === 'QSO_INGESTION'
        ? {
            table: 'activity_qso' as const,
            column: 'activation_id' as const,
          }
        : jobKind === 'ADIF_IMPORT'
          ? {
              table: 'activity_qso' as const,
              column: 'source_import_id' as const,
            }
          : {
              table: 'activity_award_progress' as const,
              column: 'award_id' as const,
            };
  const triggerName = `recovery_block_${suffix}`;
  const functionName = `recovery_block_fn_${suffix}`;
  await pool.query(
    `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       IF NEW.${blocker.column}::text = '${targetId}' THEN
         PERFORM pg_advisory_xact_lock(4815162342);
       END IF;
       RETURN NEW;
     END;
     $$`,
  );
  try {
    await pool.query(
      `CREATE TRIGGER ${triggerName} AFTER INSERT OR UPDATE ON ${blocker.table}
       FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
    );
  } catch (error) {
    await pool.query(`DROP FUNCTION ${functionName}()`).catch(() => undefined);
    throw error;
  }
  return { ...blocker, triggerName, functionName };
}

async function waitForBlockedSideEffect(
  worker: ReturnType<typeof spawnRecoveryWorker>,
  pool: Pool,
  blocker: SideEffectBlocker,
): Promise<number> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (worker.exitCode !== null || worker.signalCode !== null)
      throw new Error(
        `Activity worker exited before entering ${blocker.table} side effects: ${worker.getOutput()}`,
      );
    const result = await pool.query(
      `SELECT pid::int AS pid FROM pg_stat_activity
       WHERE datname=current_database() AND wait_event_type='Lock'
         AND query ILIKE $1 LIMIT 1`,
      [`%INSERT INTO ${blocker.table}%`],
    );
    const pid = result.rows[0]?.pid;
    if (typeof pid === 'number') return pid;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Activity worker did not reach the blocked ${blocker.table} side effect: ${worker.getOutput()}`,
  );
}

async function waitForArtifactWrite(
  worker: ReturnType<typeof spawnRecoveryWorker>,
  objectStore: RecoveryObjectStore,
) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (worker.exitCode !== null || worker.signalCode !== null)
      throw new Error(
        `Activity worker exited before writing the PDF artifact: ${worker.getOutput()}`,
      );
    if (objectStore.artifactWriteObserved) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Activity worker did not write the PDF artifact: ${worker.getOutput()}`,
  );
}

async function waitForDatabaseBackendExit(pool: Pool, pid: number) {
  await pool.query('SELECT pg_terminate_backend($1)', [pid]);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await pool.query(
      'SELECT 1 FROM pg_stat_activity WHERE pid=$1',
      [pid],
    );
    if (!result.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Activity worker PostgreSQL backend ${pid} did not exit`);
}

async function expectRolledBackSideEffects(
  pool: Pool,
  jobKind: string,
  activationId?: string,
  importId?: string,
  awardId?: string,
  subjectId?: string,
  programmeSlug?: string,
  issuanceId?: string,
  objectStore?: RecoveryObjectStore,
) {
  if (jobKind === 'QSO_INGESTION' && activationId) {
    const result = await pool.query(
      `SELECT activation.qso_count,
         (SELECT count(*)::int FROM activity_qso WHERE activation_id=$1) AS qsos,
         (SELECT count(*)::int FROM outbox_event
          WHERE aggregate_type='qso' AND aggregate_id IN
            (SELECT id::text FROM activity_qso WHERE activation_id=$1)) AS qso_events,
         (SELECT count(*)::int FROM activity_job
          WHERE idempotency_key LIKE 'batch:' || $1::text || ':%'
            AND kind='AWARD_RECALCULATE') AS award_jobs
       FROM activity_activation activation WHERE activation.id=$1`,
      [activationId],
    );
    expect(result.rows[0]).toMatchObject({
      qso_count: 0,
      qsos: 0,
      qso_events: 0,
      award_jobs: 0,
    });
    return;
  }
  if (jobKind === 'ADIF_IMPORT' && importId) {
    const result = await pool.query(
      `SELECT import.status AS import_status,import.records_seen,
         import.records_accepted,import.records_rejected,
         (SELECT count(*)::int FROM activity_qso WHERE source_import_id=$1) AS qsos,
         (SELECT count(*)::int FROM outbox_event event
          JOIN activity_qso qso ON qso.id::text=event.aggregate_id
          WHERE event.aggregate_type='qso' AND qso.source_import_id=$1) AS qso_events,
         (SELECT count(*)::int FROM activity_notification
          WHERE deduplication_key IN ($2,$3)) AS notifications
       FROM activity_import import WHERE import.id=$1`,
      [importId, `adif:${importId}:completed`, `adif:${importId}:failed`],
    );
    expect(result.rows[0]).toMatchObject({
      import_status: 'PROCESSING',
      records_seen: 0,
      records_accepted: 0,
      records_rejected: 0,
      qsos: 0,
      qso_events: 0,
      notifications: 0,
    });
    return;
  }
  if (jobKind === 'STATISTICS_REBUILD' && programmeSlug) {
    const result = await pool.query(
      `SELECT count(*)::int AS snapshots FROM activity_statistic_snapshot
       WHERE programme_slug=$1 AND algorithm_version='activity-v2'`,
      [programmeSlug],
    );
    expect(result.rows[0]?.snapshots).toBe(0);
    return;
  }
  if (
    (jobKind === 'AWARD_RECALCULATE' || jobKind === 'AWARD_EVALUATION') &&
    awardId &&
    subjectId
  ) {
    const result = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM activity_award_progress
          WHERE award_id=$1 AND subject_id=$2) AS progress,
         (SELECT count(*)::int FROM activity_notification
          WHERE recipient_id=$2 AND deduplication_key LIKE $3) AS notifications`,
      [awardId, subjectId, `award-qualified:${awardId}:1:${subjectId}%`],
    );
    expect(result.rows[0]).toMatchObject({ progress: 0, notifications: 0 });
    return;
  }
  if (jobKind === 'PDF_RENDER' && issuanceId && objectStore) {
    const result = await pool.query<{
      issuance: string;
      render_events: number;
    }>(
      `SELECT issuance::text AS issuance,
              (SELECT count(*)::int FROM outbox_event
               WHERE aggregate_type='award_issuance'
                 AND aggregate_id=activity_award_issuance.id::text) AS render_events
       FROM activity_award_issuance WHERE id=$1`,
      [issuanceId],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.render_events).toBe(0);
    expect(JSON.parse(result.rows[0]!.issuance).artifact).not.toMatchObject({
      downloadReady: true,
      renderStatus: 'READY',
    });
    const orphanedArtifact = objectStore.objects.get(
      objectStore.artifactKey ?? '',
    );
    expect(orphanedArtifact?.toString('ascii', 0, 4)).toBe('%PDF');
  }
}

async function removeSideEffectBlocker(pool: Pool, blocker: SideEffectBlocker) {
  await pool.query(
    `DROP TRIGGER IF EXISTS ${blocker.triggerName} ON ${blocker.table}`,
  );
  await pool.query(`DROP FUNCTION IF EXISTS ${blocker.functionName}()`);
}

async function waitForExit(
  worker: ReturnType<typeof spawnRecoveryWorker>,
  timeoutMilliseconds = 15_000,
): Promise<{ code: number | null; output: string }> {
  if (worker.exitCode !== null || worker.signalCode !== null)
    return { code: worker.exitCode, output: worker.getOutput() };
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      killRecoveryWorker(worker);
      reject(new Error(`Activity worker did not exit: ${worker.getOutput()}`));
    }, timeoutMilliseconds);
    worker.once('exit', (code) => {
      clearTimeout(timeout);
      resolve({ code, output: worker.getOutput() });
    });
  });
}
