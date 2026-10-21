import { spawnSync } from 'node:child_process';

const natsUrl = process.env.NATS_TEST_URL;
const databases = [
  ['core', process.env.CORE_DATABASE_URL],
  ['activity', process.env.ACTIVITY_DATABASE_URL],
  ['geodata', process.env.GEO_DATABASE_URL],
];
if (databases.some(([, value]) => !value) || !natsUrl) {
  throw new Error(
    'the Core, Activity, Geodata, and NATS test URLs are required for this check',
  );
}
for (const [name, value] of [
  ...databases.map(([owner, value]) => [`${owner}_DATABASE_URL`, value]),
  ['NATS_TEST_URL', natsUrl],
]) {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname))
    throw new Error(`${name} must point to a local test service`);
}

for (const [owner, databaseUrl] of databases) {
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
        OUTBOX_OWNER: owner,
      },
    },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
