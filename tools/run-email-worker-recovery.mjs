import { spawnSync } from 'node:child_process';

const databaseUrl = process.env.CORE_DATABASE_URL;
if (!databaseUrl) throw new Error('CORE_DATABASE_URL is required');
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname)
)
  throw new Error('Email recovery qualification requires local Postgres');

const result = spawnSync(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    'apps/email-worker/src/email-worker.recovery.spec.ts',
    '--maxWorkers=1',
    '--no-file-parallelism',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      MYOTA_EMAIL_WORKER_RECOVERY_TEST: '1',
    },
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
