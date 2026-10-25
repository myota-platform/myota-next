import { spawnSync } from 'node:child_process';

if (!process.env.ACTIVITY_DATABASE_URL || !process.env.NATS_URL)
  throw new Error(
    'Activity capacity qualification requires PostgreSQL and NATS',
  );

const result = spawnSync(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    'apps/activity-worker/src/activity-capacity-qualification.spec.ts',
    '--maxWorkers=1',
    '--no-file-parallelism',
    '--silent=false',
    '--disableConsoleIntercept',
    '--reporter=verbose',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      MYOTA_ACTIVITY_CAPACITY_QUALIFICATION: '1',
      MYOTA_ACTIVITY_CAPACITY_ENFORCE_LIMITS: '1',
      ACTIVITY_WORKER_HEALTH_PORT: '19112',
      OUTBOX_OWNER: 'activity',
      OUTBOX_WORKER: 'activity-capacity-outbox',
      OUTBOX_METRICS_PORT: '0',
      MYOTA_ACTIVITY_DB_POOL_MAX: '12',
      MYOTA_UPLOAD_MAX_BYTES: String(25 * 1024 * 1024),
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--max-old-space-size=768']
        .filter(Boolean)
        .join(' '),
    },
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
