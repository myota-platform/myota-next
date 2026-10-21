import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import { GeodataWorkRepository } from './geodata-work.repository.js';

const recoveryTestName =
  'replays committed staging after a worker process is killed';

describe('Geodata worker process recovery', () => {
  it.skipIf(
    process.env.MYOTA_GEO_WORKER_RECOVERY_TEST !== '1' ||
      !process.env.GEO_DATABASE_URL,
  )(
    recoveryTestName,
    async () => {
      if (process.env.MYOTA_GEO_WORKER_RECOVERY_PHASE) {
        await runRecoveryWorkerPhase();
        return;
      }
      await verifyWorkerRecovery();
    },
    120_000,
  );
});

async function runRecoveryWorkerPhase() {
  const databaseUrl = process.env.GEO_DATABASE_URL;
  const runId = process.env.MYOTA_GEO_WORKER_RECOVERY_RUN_ID;
  const phase = process.env.MYOTA_GEO_WORKER_RECOVERY_PHASE;
  if (!databaseUrl || !runId || !phase)
    throw new Error('worker recovery phase is missing its test settings');

  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const repository = new GeodataWorkRepository(pool as Pool);
  const featureChunks = recoveryFeatureChunks(runId);
  let getObjectCalls = 0;
  const originalSend = S3Client.prototype.send.bind(S3Client.prototype);
  S3Client.prototype.send = (async (command: unknown) => {
    if (!(command instanceof GetObjectCommand))
      throw new Error('unexpected S3 command in worker recovery fixture');
    getObjectCalls++;
    const interruptAfterCheckpoint =
      phase === 'interrupt' && getObjectCalls === 2;
    return {
      Body: Readable.from(
        recoveryBody(featureChunks, interruptAfterCheckpoint),
      ),
    };
  }) as typeof S3Client.prototype.send;

  try {
    const run = await repository.claim(runId);
    if (!run) throw new Error('worker could not claim the recovery fixture');
    await repository.preprocess(run);
  } finally {
    S3Client.prototype.send = originalSend;
    await pool.end();
  }
}

async function verifyWorkerRecovery() {
  const databaseUrl = process.env.GEO_DATABASE_URL;
  if (!databaseUrl) throw new Error('GEO_DATABASE_URL is required');
  const database = new URL(databaseUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(database.hostname))
    throw new Error('worker recovery qualification requires local Postgres');

  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const runId = randomUUID();
  const featureCount = 250;
  const chunks = recoveryFeatureChunks(runId, featureCount);
  const sourceHash = createHash('sha256')
    .update(Buffer.concat(chunks))
    .digest('hex');
  const workerEnvironment = {
    ...process.env,
    GEO_DATABASE_URL: databaseUrl,
    MYOTA_GEO_WORKER_RECOVERY_TEST: '1',
    MYOTA_GEO_WORKER_RECOVERY_RUN_ID: runId,
  };
  let interrupted: ReturnType<typeof spawnRecoveryWorker> | undefined;

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await client.query(
        `INSERT INTO import_run
          (id,adapter_code,source_metadata,status,source_key,source_hash)
         VALUES ($1,'MANUAL',$2::jsonb,'QUEUED',$3,$4)`,
        [
          runId,
          stringifyJsonWithBigInts({
            source: { name: `worker-kill-${runId}` },
            sourceObject: { bucket: 'test-bucket', key: `test/${runId}.json` },
            filename: `${runId}.geojson`,
            format: 'GEOJSON',
            entityTypes: ['TEST_PARK'],
          }),
          `test/${runId}.json`,
          sourceHash,
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    interrupted = spawnRecoveryWorker('interrupt', workerEnvironment);
    await waitForCheckpoint(interrupted, pool, runId);
    interrupted.kill('SIGKILL');
    await waitForExit(interrupted);

    const recoveryClient = await pool.connect();
    try {
      await recoveryClient.query('BEGIN');
      await recoveryClient.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await recoveryClient.query(
        `UPDATE import_run SET lease_until=now()-interval '1 second',
             work_dispatched_at=now()-interval '301 seconds' WHERE id=$1`,
        [runId],
      );
      await recoveryClient.query('COMMIT');
    } catch (error) {
      await recoveryClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      recoveryClient.release();
    }

    const recovered = await new GeodataWorkRepository(
      pool,
    ).recoverExpiredWorkDispatches(300);
    expect(recovered.preprocessing).toBe(1);
    const replay = spawnRecoveryWorker('replay', workerEnvironment);
    const replayResult = await waitForExit(replay, 120_000);
    expect(replayResult.code, replayResult.output).toBe(0);

    const result = await pool.query(
      `SELECT run.status,run.attempt_count,count(candidate.ordinal)::int AS count,
           count(DISTINCT candidate.ordinal)::int AS distinct_ordinals
         FROM import_run run LEFT JOIN geodata_import_candidate candidate
           ON candidate.import_run_id=run.id WHERE run.id=$1
         GROUP BY run.id`,
      [runId],
    );
    expect(result.rows[0]).toMatchObject({
      status: 'PREPROCESSED',
      attempt_count: 2,
      count: featureCount,
      distinct_ordinals: featureCount,
    });
  } finally {
    if (interrupted && interrupted.exitCode === null) {
      interrupted.kill('SIGKILL');
      await waitForExit(interrupted).catch(() => undefined);
    }
    await cleanupRecoveryFixture(pool, runId);
  }
}

async function cleanupRecoveryFixture(pool: Pool, runId: string) {
  const cleanup = await pool.connect();
  let cleanupError: unknown;
  try {
    await cleanup.query('BEGIN');
    await cleanup.query(
      "SELECT set_config('myota.geodata_writer','row-v1',true)",
    );
    await cleanup.query(
      `DELETE FROM source_snapshot_record WHERE manifest_id IN
             (SELECT id FROM source_snapshot_manifest WHERE import_run_id=$1)`,
      [runId],
    );
    await cleanup.query(
      'DELETE FROM source_snapshot_manifest WHERE import_run_id=$1',
      [runId],
    );
    await cleanup.query('DELETE FROM outbox_event WHERE aggregate_id=$1', [
      runId,
    ]);
    await cleanup.query('DELETE FROM import_run WHERE id=$1', [runId]);
    await cleanup.query('COMMIT');
  } catch (error) {
    await cleanup.query('ROLLBACK').catch(() => undefined);
    cleanupError = error;
  } finally {
    cleanup.release();
  }
  await pool.end();
  if (cleanupError) throw cleanupError;
}

function recoveryFeatureChunks(runId: string, count = 250): Buffer[] {
  const chunks = [
    Buffer.from('{"type":"FeatureCollection","features":[', 'utf8'),
  ];
  for (let ordinal = 0; ordinal < count; ordinal++) {
    if (ordinal) chunks.push(Buffer.from(',', 'utf8'));
    chunks.push(
      Buffer.from(
        stringifyJsonWithBigInts({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-5.99, 37.39] },
          properties: {
            name: `worker fixture ${ordinal}`,
            sourceRef: `${runId}-${ordinal}`,
          },
        }),
        'utf8',
      ),
    );
  }
  chunks.push(Buffer.from(']}', 'utf8'));
  return chunks;
}

async function* recoveryBody(
  chunks: Buffer[],
  pauseAfterCheckpoint: boolean,
): AsyncGenerator<Buffer> {
  for (let index = 0; index < chunks.length; index++) {
    yield chunks[index]!;
    if (pauseAfterCheckpoint && index === 200) {
      await new Promise<void>(() => undefined);
    }
  }
}

function spawnRecoveryWorker(
  phase: 'interrupt' | 'replay',
  environment: NodeJS.ProcessEnv,
) {
  const child = spawn(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      'apps/geodata-worker/src/geodata-worker-recovery.spec.ts',
      '-t',
      recoveryTestName,
      '--maxWorkers=1',
      '--no-file-parallelism',
    ],
    {
      env: { ...environment, MYOTA_GEO_WORKER_RECOVERY_PHASE: phase },
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

async function waitForCheckpoint(
  child: ReturnType<typeof spawnRecoveryWorker>,
  pool: Pool,
  runId: string,
) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`worker exited before checkpoint: ${child.getOutput()}`);
    const result = await pool.query(
      'SELECT count(*)::int AS count FROM geodata_import_candidate_stage WHERE import_run_id=$1',
      [runId],
    );
    if (result.rows[0]?.count === 100) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `worker did not stage its first 100 features: ${child.getOutput()}`,
  );
}

async function waitForExit(
  child: ReturnType<typeof spawnRecoveryWorker>,
  timeoutMilliseconds = 15_000,
): Promise<{ code: number | null; output: string }> {
  if (child.exitCode !== null || child.signalCode !== null)
    return { code: child.exitCode, output: child.getOutput() };
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`worker did not exit: ${child.getOutput()}`));
    }, timeoutMilliseconds);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve({ code, output: child.getOutput() });
    });
  });
}
