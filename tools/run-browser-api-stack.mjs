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

const objects = new Map();
const objectStorageServer = createServer((request, response) => {
  void (async () => {
    const segments = new URL(request.url ?? '/', 'http://localhost').pathname
      .split('/')
      .slice(1)
      .map(decodeURIComponent);
    const bucket = segments.shift();
    const key = segments.join('/');
    if (!bucket || !key) {
      response.writeHead(400).end();
      return;
    }
    const objectId = `${bucket}/${key}`;
    if (request.method === 'PUT') {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      objects.set(objectId, {
        body: Buffer.concat(chunks),
        contentType:
          request.headers['content-type'] ?? 'application/octet-stream',
      });
      response.writeHead(200, { etag: '"browser-object-store"' }).end();
      return;
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      const object = objects.get(objectId);
      if (!object) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'content-type': object.contentType,
        'content-length': object.body.length,
      });
      response.end(request.method === 'HEAD' ? undefined : object.body);
      return;
    }
    if (request.method === 'DELETE') {
      objects.delete(objectId);
      response.writeHead(204).end();
      return;
    }
    response.writeHead(405).end();
  })().catch((error) => {
    console.error('browser object storage request failed', error);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});
const objectStoragePort = await new Promise((resolve, reject) => {
  objectStorageServer.once('error', reject);
  objectStorageServer.listen(0, '127.0.0.1', () => {
    const address = objectStorageServer.address();
    if (!address || typeof address === 'string') {
      reject(new Error('could not start browser object storage'));
      return;
    }
    resolve(address.port);
  });
});

const baseEnvironment = {
  ...process.env,
  MYOTA_OBJECT_STORAGE_ENDPOINT: `http://127.0.0.1:${objectStoragePort}`,
  MYOTA_OBJECT_STORAGE_ACCESS_KEY:
    process.env.MYOTA_OBJECT_STORAGE_ACCESS_KEY ?? 'browser-s3-access',
  MYOTA_OBJECT_STORAGE_SECRET_KEY:
    process.env.MYOTA_OBJECT_STORAGE_SECRET_KEY ?? 'browser-s3-secret',
  MYOTA_OBJECT_STORAGE_ADDRESSING_STYLE: 'path',
  MYOTA_AWARD_ASSET_BUCKET: 'browser-award-assets',
  MYOTA_AWARD_SIGNATURE_BUCKET: 'browser-award-signatures',
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
  objectStorageServer.close();
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
