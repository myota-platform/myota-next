import { spawnSync } from 'node:child_process';

if (!process.env.GEO_DATABASE_URL)
  throw new Error('Geodata capacity qualification requires PostgreSQL');

const result = spawnSync(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    'apps/geodata/src/geodata-capacity-qualification.spec.ts',
    'apps/geodata-worker/src/geodata-import-capacity-qualification.spec.ts',
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
      MYOTA_GEODATA_CAPACITY_QUALIFICATION: '1',
      MYOTA_GEODATA_CAPACITY_ENFORCE_LIMITS: '1',
      MYOTA_DB_POOL_MAX: '10',
      GEODATA_WORKER_HEALTH_PORT: '19113',
      OUTBOX_OWNER: 'geodata',
      OUTBOX_WORKER: 'geodata-capacity-outbox',
      OUTBOX_METRICS_PORT: '0',
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--max-old-space-size=768']
        .filter(Boolean)
        .join(' '),
    },
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
