import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';

const manifest = await readFile(
  new URL('../deploy/testing/observe-mock-collector.yaml', import.meta.url),
  'utf8',
);
const start = manifest.indexOf('  collector.mjs: |\n');
assert.notEqual(start, -1, 'collector ConfigMap script must exist');
const scriptStart = start + '  collector.mjs: |\n'.length;
const scriptEnd = manifest.indexOf('\n---\n', scriptStart);
assert.notEqual(
  scriptEnd,
  -1,
  'collector script must end before the next resource',
);
const collectorSource = manifest
  .slice(scriptStart, scriptEnd)
  .split('\n')
  .map((line) => (line.startsWith('    ') ? line.slice(4) : line))
  .join('\n');

const appKey = 'observe-mock-test-key';
const appSecret = 'observe-mock-test-secret';
const marker = `synthetic-reset-token-${randomBytes(32).toString('base64url')}`;
const requestId = randomUUID();
const scanId = randomUUID();
let stdout = '';
let stderr = '';
const collector = spawn(
  process.execPath,
  ['--input-type=module', '--eval', collectorSource],
  {
    env: {
      ...process.env,
      MOCK_APP_KEY: appKey,
      MOCK_APP_SECRET: appSecret,
      MOCK_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
collector.stdout.setEncoding('utf8').on('data', (chunk) => {
  stdout += chunk;
});
collector.stderr.setEncoding('utf8').on('data', (chunk) => {
  stderr += chunk;
});

async function waitForPort() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const ready = stdout
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .find((entry) => entry?.event === 'collector-ready');
    if (Number.isInteger(ready?.port)) return ready.port;
    if (collector.exitCode !== null)
      throw new Error('Observe mock collector exited before becoming ready');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Observe mock collector did not become ready');
}

let server;
let scannerStarted = false;
const credentials = {
  'x-api-key': appKey,
  'x-api-secret': appSecret,
};

try {
  const port = await waitForPort();
  server = `http://127.0.0.1:${port}`;

  const unauthorized = await fetch(`${server}/__test/token-scans`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(unauthorized.status, 401);

  const startScan = await fetch(`${server}/__test/token-scans`, {
    method: 'POST',
    headers: { ...credentials, 'content-type': 'application/json' },
    body: JSON.stringify({ id: scanId, marker, requestId }),
  });
  assert.equal(startScan.status, 201);
  scannerStarted = true;

  async function sendTelemetry(item) {
    const response = await fetch(`${server}/applications/telemetry`, {
      method: 'POST',
      headers: {
        ...credentials,
        'content-encoding': 'gzip',
        'content-type': 'application/json',
      },
      body: gzipSync(
        JSON.stringify({
          serviceId: 'identity-api',
          serviceVersion: 'test',
          snapshots: [item],
          logs: [],
        }),
      ),
    });
    assert.equal(response.status, 200);
  }

  await sendTelemetry({
    ti: requestId,
    a: { ou: 'identity.recovery.reset' },
    status: 'ok',
  });
  const clearResult = await fetch(`${server}/__test/token-scans/${scanId}`, {
    headers: credentials,
  }).then((response) => response.json());
  assert.deepEqual(clearResult, {
    requestObserved: true,
    tokenObserved: false,
  });

  await sendTelemetry({
    ti: requestId,
    a: { ou: 'identity.recovery.reset' },
    diagnostic: marker,
  });
  const leakResult = await fetch(`${server}/__test/token-scans/${scanId}`, {
    headers: credentials,
  }).then((response) => response.json());
  assert.deepEqual(leakResult, {
    requestObserved: true,
    tokenObserved: true,
  });

  const deleted = await fetch(`${server}/__test/token-scans/${scanId}`, {
    method: 'DELETE',
    headers: credentials,
  });
  assert.equal(deleted.status, 204);
  scannerStarted = false;
  const missingScan = await fetch(`${server}/__test/token-scans/${scanId}`, {
    headers: credentials,
  });
  assert.equal(missingScan.status, 404);
  assert.equal(stdout.includes(marker), false);
  assert.equal(stderr.includes(marker), false);
  console.log(
    'Observe mock token scanner checks passed without logging the marker.',
  );
} finally {
  if (scannerStarted && server) {
    await fetch(`${server}/__test/token-scans/${scanId}`, {
      method: 'DELETE',
      headers: credentials,
    }).catch(() => undefined);
  }
  collector.kill('SIGTERM');
  await new Promise((resolve) => {
    if (collector.exitCode !== null) return resolve();
    collector.once('exit', resolve);
    setTimeout(resolve, 1000);
  });
}
