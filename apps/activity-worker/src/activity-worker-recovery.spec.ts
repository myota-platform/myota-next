import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { stringifyJsonWithBigInts } from '../../../libs/platform/src/json-bigint.js';
import { ActivityWorkRepository } from './activity-work.repository.js';

const recoveryTestName = 'reclaims an Activity job after worker process death';

describe('Activity worker process recovery', () => {
  it.skipIf(
    process.env.MYOTA_ACTIVITY_WORKER_RECOVERY_TEST !== '1' ||
      !process.env.ACTIVITY_DATABASE_URL,
  )(
    recoveryTestName,
    async () => {
      if (process.env.MYOTA_ACTIVITY_WORKER_RECOVERY_PHASE) {
        await runInterruptedWorkerPhase();
        return;
      }
      await verifyWorkerRecovery();
    },
    120_000,
  );
});

async function runInterruptedWorkerPhase() {
  const databaseUrl = process.env.ACTIVITY_DATABASE_URL;
  const jobId = process.env.MYOTA_ACTIVITY_WORKER_RECOVERY_JOB_ID;
  if (!databaseUrl || !jobId)
    throw new Error('Activity worker recovery phase is missing its settings');

  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const job = await new ActivityWorkRepository(pool).claimWorkJob(
      jobId,
      'STATISTICS_REBUILD',
      120,
    );
    if (!job) throw new Error('Activity worker could not claim the fixture');
    await new Promise<void>(() => setInterval(() => undefined, 1000));
  } finally {
    await pool.end();
  }
}

async function verifyWorkerRecovery() {
  const databaseUrl = process.env.ACTIVITY_DATABASE_URL;
  if (!databaseUrl) throw new Error('ACTIVITY_DATABASE_URL is required');
  const database = new URL(databaseUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(database.hostname))
    throw new Error('Activity recovery qualification requires local Postgres');

  const pool = new Pool({ connectionString: databaseUrl, max: 3 });
  const jobId = randomUUID();
  const programmeSlug = `worker-recovery-${jobId}`;
  const workerEnvironment = {
    ...process.env,
    ACTIVITY_DATABASE_URL: databaseUrl,
    MYOTA_ACTIVITY_WORKER_RECOVERY_TEST: '1',
    MYOTA_ACTIVITY_WORKER_RECOVERY_PHASE: 'interrupt',
    MYOTA_ACTIVITY_WORKER_RECOVERY_JOB_ID: jobId,
  };
  let worker: ReturnType<typeof spawnRecoveryWorker> | undefined;

  try {
    await pool.query(
      `INSERT INTO activity_job(id,kind,payload)
       VALUES ($1,'STATISTICS_REBUILD',$2::jsonb)`,
      [jobId, stringifyJsonWithBigInts({ programmeSlug })],
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
    const recovered = await repository.claimWorkJob(
      jobId,
      'STATISTICS_REBUILD',
      120,
    );
    expect(recovered).toMatchObject({ id: jobId, attempts: 2 });
    if (!recovered) throw new Error('Activity job lease was not reclaimed');
    await repository.process(recovered);

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
  } finally {
    if (worker && worker.exitCode === null) {
      worker.kill('SIGKILL');
      await waitForExit(worker).catch(() => undefined);
    }
    await cleanupRecoveryFixture(pool, jobId, programmeSlug);
  }
}

async function cleanupRecoveryFixture(
  pool: Pool,
  jobId: string,
  programmeSlug: string,
) {
  let cleanupError: unknown;
  try {
    await pool.query(
      `DELETE FROM activity_statistic_snapshot
       WHERE programme_slug=$1 AND algorithm_version='activity-v2'`,
      [programmeSlug],
    );
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
      recoveryTestName,
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
