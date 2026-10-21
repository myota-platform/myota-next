import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const requiredDatabaseVariables = [
  'CORE_DATABASE_URL',
  'ACTIVITY_DATABASE_URL',
  'GEO_DATABASE_URL',
];
for (const name of requiredDatabaseVariables) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}

const baseEnvironment = {
  ...process.env,
  MYOTA_AUTH_SIGNING_KEY:
    process.env.MYOTA_AUTH_SIGNING_KEY ?? 'browser-integration-signing-key',
  MYOTA_BOOTSTRAP_ADMIN_EMAIL:
    process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL ?? 'browser-e2e-admin@example.test',
  MYOTA_BOOTSTRAP_ADMIN_PASSWORD:
    process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD ?? 'browser-e2e-password-7!Q',
};

const services = [
  ['identity', 8001],
  ['programmes', 8002],
  ['geodata', 8003],
  ['activity', 8004],
  ['gateway', 8080],
];
const children = [];
let stopping = false;
let readinessServer;

function stop() {
  if (stopping) return;
  stopping = true;
  readinessServer?.close();
  for (const child of children) child.kill('SIGTERM');
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

for (const [name, port] of services) {
  const child = spawn(process.execPath, [`dist/apps/${name}/main.js`], {
    env: {
      ...baseEnvironment,
      PORT: String(port),
      ...(name === 'gateway'
        ? {
            MYOTA_IDENTITY_URL: 'http://127.0.0.1:8001',
            MYOTA_PROGRAMMES_URL: 'http://127.0.0.1:8002',
            MYOTA_GEODATA_URL: 'http://127.0.0.1:8003',
            MYOTA_ACTIVITY_URL: 'http://127.0.0.1:8004',
          }
        : {}),
    },
    stdio: 'inherit',
  });
  children.push(child);
  child.on('exit', (code) => {
    if (!stopping) {
      console.error(`${name} exited unexpectedly with code ${code}`);
      stop();
      process.exitCode = 1;
    }
  });
}

await new Promise((resolve, reject) => {
  const deadline = Date.now() + 85_000;
  const check = async () => {
    if (stopping) {
      reject(new Error('API stack stopped before Gateway became ready'));
      return;
    }
    try {
      const responses = await Promise.all(
        services.map(([, port]) =>
          fetch(`http://127.0.0.1:${port}/readyz`, {
            signal: AbortSignal.timeout(1_000),
          }),
        ),
      );
      if (responses.every((response) => response.ok)) {
        resolve();
        return;
      }
    } catch {
      // Services are still starting.
    }
    if (Date.now() >= deadline) {
      reject(new Error('Gateway did not become ready within 85 seconds'));
      return;
    }
    setTimeout(check, 500);
  };
  void check();
});

readinessServer = createServer((request, response) => {
  if (request.url === '/readyz') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"status":"ok"}');
    return;
  }
  response.writeHead(404);
  response.end();
});
readinessServer.listen(18080, '127.0.0.1');

await new Promise((resolve) => {
  const finish = () => {
    if (children.every((child) => child.exitCode !== null)) resolve();
    else setTimeout(finish, 100);
  };
  finish();
});
