import { spawnSync } from 'node:child_process';

const databaseUrl = process.env.ACTIVITY_DATABASE_URL;
if (!databaseUrl) throw new Error('ACTIVITY_DATABASE_URL is required');
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname)
)
  throw new Error('ACTIVITY_DATABASE_URL must point to local test Postgres');

const result = spawnSync(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    'apps/activity-notifications/src/activity-notifications.restart-recovery.spec.ts',
    '--maxWorkers=1',
    '--no-file-parallelism',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      ACTIVITY_DATABASE_URL: databaseUrl,
      ACTIVITY_NOTIFICATION_METRICS_PORT: '0',
      MYOTA_ACTIVITY_NOTIFICATION_RESTART_TEST: '1',
    },
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
