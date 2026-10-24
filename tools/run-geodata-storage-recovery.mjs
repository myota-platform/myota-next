import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const databaseUrl = process.env.GEO_DATABASE_URL;
if (!databaseUrl) throw new Error('GEO_DATABASE_URL is required');
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname)
)
  throw new Error('GEO_DATABASE_URL must point to local test Postgres');

const image =
  'chrislusf/seaweedfs:latest@sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882';
if (!readFileSync('deploy/compose.yaml', 'utf8').includes(image))
  throw new Error('storage recovery image must match the pinned Compose image');

const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
const container = `myota-geodata-storage-recovery-${suffix}`;
const volume = `${container}-data`;
const directory = await mkdtemp(join(tmpdir(), 'myota-seaweedfs-recovery-'));
const config = join(directory, 's3.json');
const bucket = `myota-geodata-recovery-${suffix}`;
const accessKey = `myota-recovery-${suffix}`;
const secretKey = `myota-recovery-secret-${suffix}`;
const profileAccessKey = `myota-profile-${suffix}`;
const profileSecretKey = `myota-profile-secret-${suffix}`;
const endpoint = 'http://127.0.0.1:18333';
let volumeCreated = false;
let containerCreated = false;

function docker(args) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `docker ${args.join(' ')} failed: ${result.stderr || result.stdout}`,
    );
  return result.stdout.trim();
}

function runProcess(command, args, env) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: 'inherit',
    env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

async function waitForSeaweedFS() {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('/status', endpoint), {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
    } catch {
      // Retry until the S3 gateway is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const state = spawnSync(
    'docker',
    ['inspect', '--format', '{{.State.Status}}', container],
    { encoding: 'utf8' },
  );
  const logs = spawnSync('docker', ['logs', container], { encoding: 'utf8' });
  throw new Error(
    `SeaweedFS did not become ready (state: ${state.stdout?.trim() || 'unknown'}):\n${logs.stdout || ''}${logs.stderr || ''}`,
  );
}

try {
  runProcess(
    process.execPath,
    ['--experimental-strip-types', 'tools/render-seaweedfs-s3-config.ts'],
    {
      ...process.env,
      OUTPUT_PATH: config,
      MYOTA_OBJECT_STORAGE_ACCESS_KEY: accessKey,
      MYOTA_OBJECT_STORAGE_SECRET_KEY: secretKey,
      MYOTA_PROFILE_IMAGE_ACCESS_KEY: profileAccessKey,
      MYOTA_PROFILE_IMAGE_SECRET_KEY: profileSecretKey,
      MYOTA_PROFILE_IMAGE_BUCKET: `myota-profile-recovery-${suffix}`,
    },
  );
  if (process.exitCode) throw new Error('could not render SeaweedFS S3 config');
  await chmod(directory, 0o755);
  await chmod(config, 0o644);
  docker(['volume', 'create', volume]);
  volumeCreated = true;
  docker([
    'run',
    '--detach',
    '--name',
    container,
    '--publish',
    '127.0.0.1:18333:8333',
    '--volume',
    `${directory}:/etc/seaweedfs-auth:ro`,
    '--volume',
    `${volume}:/data`,
    image,
    'mini',
    '-dir=/data',
    '-ip.bind=0.0.0.0',
    '-metricsPort=9324',
    '-s3.config=/etc/seaweedfs-auth/s3.json',
  ]);
  containerCreated = true;
  await waitForSeaweedFS();

  runProcess(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      'apps/geodata/src/geodata-upload-recovery.spec.ts',
      '--maxWorkers=1',
      '--no-file-parallelism',
    ],
    {
      ...process.env,
      AWS_MAX_ATTEMPTS: '1',
      GEO_DATABASE_URL: databaseUrl,
      MYOTA_GEO_STORAGE_RECOVERY_TEST: '1',
      MYOTA_OBJECT_STORAGE_ENDPOINT: endpoint,
      MYOTA_OBJECT_STORAGE_REGION: 'us-east-1',
      MYOTA_OBJECT_STORAGE_ADDRESSING_STYLE: 'path',
      MYOTA_OBJECT_STORAGE_ACCESS_KEY: accessKey,
      MYOTA_OBJECT_STORAGE_SECRET_KEY: secretKey,
      MYOTA_GEODATA_IMPORT_BUCKET: bucket,
      MYOTA_S3_RECOVERY_CONTAINER: container,
      MYOTA_S3_RECOVERY_VOLUME: volume,
    },
  );
  if (!process.exitCode)
    runProcess(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        'apps/geodata-worker/src/geodata-worker-recovery.spec.ts',
        '-t',
        'retries import preprocessing after a temporary object-store outage',
        '--maxWorkers=1',
        '--no-file-parallelism',
      ],
      {
        ...process.env,
        AWS_MAX_ATTEMPTS: '1',
        GEO_DATABASE_URL: databaseUrl,
        MYOTA_GEO_WORKER_RECOVERY_TEST: '1',
        MYOTA_OBJECT_STORAGE_ENDPOINT: endpoint,
        MYOTA_OBJECT_STORAGE_REGION: 'us-east-1',
        MYOTA_OBJECT_STORAGE_ADDRESSING_STYLE: 'path',
        MYOTA_OBJECT_STORAGE_ACCESS_KEY: accessKey,
        MYOTA_OBJECT_STORAGE_SECRET_KEY: secretKey,
        MYOTA_GEODATA_IMPORT_BUCKET: bucket,
        MYOTA_S3_RECOVERY_CONTAINER: container,
      },
    );
} finally {
  const cleanupErrors = [];
  if (containerCreated) {
    try {
      docker(['rm', '--force', container]);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (volumeCreated) {
    try {
      docker(['volume', 'rm', '--force', volume]);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  await rm(directory, { recursive: true, force: true });
  if (cleanupErrors.length) {
    console.error('SeaweedFS recovery fixture cleanup failed:', cleanupErrors);
    process.exitCode = 1;
  }
}

if (process.exitCode) process.exit(process.exitCode);
