import { spawnSync } from 'node:child_process';

const databaseUrl = process.env.ACTIVITY_DATABASE_URL;
if (!databaseUrl) {
  throw new Error('ACTIVITY_DATABASE_URL is required for this check');
}
const databaseHost = new URL(databaseUrl).hostname;
if (
  !['localhost', '127.0.0.1', '[::1]', 'activity-db'].includes(databaseHost)
) {
  throw new Error(
    'ACTIVITY_DATABASE_URL must point to a local test database for this check',
  );
}

const result = spawnSync(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    'apps/activity-worker/src/activity-worker-recovery.spec.ts',
    'apps/activity-worker/src/activity-worker.restart-recovery.spec.ts',
    '--maxWorkers=1',
    '--no-file-parallelism',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      AWS_MAX_ATTEMPTS: '1',
      MYOTA_ACTIVITY_WORKER_RECOVERY_TEST: '1',
      ACTIVITY_WORK_RECONCILE_SECONDS: '5',
    },
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
