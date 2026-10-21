import { spawnSync } from 'node:child_process';

const databaseUrl = process.env.ACTIVITY_DATABASE_URL;
const natsUrl = process.env.NATS_TEST_URL;
if (!databaseUrl || !natsUrl) {
  throw new Error(
    'ACTIVITY_DATABASE_URL and NATS_TEST_URL are required for this check',
  );
}
for (const [name, value] of [
  ['ACTIVITY_DATABASE_URL', databaseUrl],
  ['NATS_TEST_URL', natsUrl],
]) {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname))
    throw new Error(`${name} must point to a local test service`);
}

const result = spawnSync(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    'apps/outbox-worker/src/outbox-recovery.spec.ts',
    '--maxWorkers=1',
    '--no-file-parallelism',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      OUTBOX_DATABASE_URL: databaseUrl,
      MYOTA_OUTBOX_RECOVERY_TEST: '1',
      OUTBOX_OWNER: 'activity',
    },
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
