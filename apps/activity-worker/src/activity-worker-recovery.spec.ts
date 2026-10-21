import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
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
  const awardId = jobKind === 'AWARD_RECALCULATE' ? randomUUID() : undefined;
  const subjectId = `worker-recovery-subject-${jobId}`;
  const workerEnvironment = {
    ...process.env,
    ACTIVITY_DATABASE_URL: databaseUrl,
    MYOTA_ACTIVITY_WORKER_RECOVERY_TEST: '1',
    MYOTA_ACTIVITY_WORKER_RECOVERY_PHASE: 'interrupt',
    MYOTA_ACTIVITY_WORKER_RECOVERY_JOB_ID: jobId,
    MYOTA_ACTIVITY_WORKER_RECOVERY_JOB_KIND: jobKind,
    MYOTA_ACTIVITY_WORKER_RECOVERY_TEST_NAME: testName,
  };
  let worker: ReturnType<typeof spawnRecoveryWorker> | undefined;

  try {
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
      await pool.query(
        `INSERT INTO activity_subject_aggregate
           (programme_slug,subject_id,category,qso_count,activation_count)
         VALUES ($1,$2,'ACTIVATOR',7,1)`,
        [programmeSlug, subjectId],
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
            : { programmeSlug, subjectIds: [subjectId] },
        ),
      ],
    );

    worker = spawnRecoveryWorker(workerEnvironment);
    await waitForClaim(worker, pool, jobId);
    worker.kill('SIGKILL');
    await waitForExit(worker);

    await pool.query(
      `UPDATE activity_job SET lease_expires_at=now()-interval '1 second'
       WHERE id=$1`,
      [jobId],
    );
    const repository = new ActivityWorkRepository(pool);
    const recovered = await repository.claimWorkJob(jobId, jobKind, 120);
    expect(recovered).toMatchObject({ id: jobId, attempts: 2 });
    if (!recovered) throw new Error('Activity job lease was not reclaimed');
    await repository.process(recovered);

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
    } else {
      const result = await pool.query(
        `SELECT job.status,job.attempts,progress.evaluation
         FROM activity_job job LEFT JOIN activity_award_progress progress
           ON progress.award_id=$2 AND progress.award_version=1
             AND progress.subject_id=$3
         WHERE job.id=$1`,
        [jobId, awardId, subjectId],
      );
      expect(result.rows[0]).toMatchObject({
        status: 'SUCCEEDED',
        attempts: 2,
        evaluation: {
          conditionMet: true,
          metric: 'QSO_COUNT',
          progress: 7,
          levels: [{ id: 'level-5', eligible: true }],
        },
      });
    }
  } finally {
    if (worker && worker.exitCode === null) {
      worker.kill('SIGKILL');
      await waitForExit(worker).catch(() => undefined);
    }
    await cleanupRecoveryFixture(
      pool,
      jobId,
      programmeSlug,
      awardId,
      subjectId,
    );
  }
}

async function cleanupRecoveryFixture(
  pool: Pool,
  jobId: string,
  programmeSlug: string,
  awardId?: string,
  subjectId?: string,
) {
  let cleanupError: unknown;
  try {
    await pool.query(
      `DELETE FROM activity_statistic_snapshot
       WHERE programme_slug=$1 AND algorithm_version='activity-v2'`,
      [programmeSlug],
    );
    if (awardId && subjectId) {
      await pool.query(
        `DELETE FROM activity_notification
         WHERE deduplication_key LIKE $1`,
        [`award-qualified:${awardId}:1:${subjectId}:%`],
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
    await pool.query('DELETE FROM activity_job WHERE id=$1', [jobId]);
  } catch (error) {
    cleanupError = error;
  }
  await pool.end();
  if (cleanupError) throw cleanupError;
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
    ],
    { env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
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

async function waitForExit(
  worker: ReturnType<typeof spawnRecoveryWorker>,
  timeoutMilliseconds = 15_000,
): Promise<{ code: number | null; output: string }> {
  if (worker.exitCode !== null || worker.signalCode !== null)
    return { code: worker.exitCode, output: worker.getOutput() };
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.kill('SIGKILL');
      reject(new Error(`Activity worker did not exit: ${worker.getOutput()}`));
    }, timeoutMilliseconds);
    worker.once('exit', (code) => {
      clearTimeout(timeout);
      resolve({ code, output: worker.getOutput() });
    });
  });
}
