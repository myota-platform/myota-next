import { spawnSync } from 'node:child_process';

const databaseUrl = process.env.GEO_DATABASE_URL;
if (!databaseUrl) {
  throw new Error('GEO_DATABASE_URL is required for this check');
}
const databaseHost = new URL(databaseUrl).hostname;
if (!['localhost', '127.0.0.1', '[::1]', 'geo-db'].includes(databaseHost)) {
  throw new Error(
    'GEO_DATABASE_URL must point to a local test database for this check',
  );
}

const result = spawnSync(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    'apps/geodata-worker/src/geodata-worker-recovery.spec.ts',
    '--maxWorkers=1',
    '--no-file-parallelism',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      MYOTA_GEO_WORKER_RECOVERY_TEST: '1',
    },
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
