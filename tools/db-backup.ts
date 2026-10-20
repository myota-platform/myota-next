import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const owners = {
  core: 'CORE_DATABASE_URL',
  activity: 'ACTIVITY_DATABASE_URL',
  geo: 'GEO_DATABASE_URL',
} as const;
type Owner = keyof typeof owners;

type DatabaseConfig = {
  database: string;
  environment: NodeJS.ProcessEnv;
};

type BackupManifest = {
  manifestVersion: 1;
  format: 'postgres-custom';
  createdAt: string;
  databases: Record<Owner, { database: string; file: string; sha256: string }>;
};

function databaseConfig(owner: Owner): DatabaseConfig {
  const variable = owners[owner];
  const raw = process.env[variable];
  if (!raw) throw new Error(`${variable} is required`);
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error(`${variable} must be a PostgreSQL URL`);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const user = decodeURIComponent(url.username);
  if (!database || !url.hostname || !user)
    throw new Error(`${variable} must include host, database, and user`);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: user,
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: database,
    PGAPPNAME: `myota-${owner}-backup`,
  };
  const queryVariables: Record<string, string> = {
    sslmode: 'PGSSLMODE',
    sslrootcert: 'PGSSLROOTCERT',
    sslcert: 'PGSSLCERT',
    sslkey: 'PGSSLKEY',
    application_name: 'PGAPPNAME',
    connect_timeout: 'PGCONNECT_TIMEOUT',
  };
  for (const [key, value] of url.searchParams) {
    const target = queryVariables[key];
    if (!target)
      throw new Error(`${variable} has unsupported URL parameter: ${key}`);
    environment[target] = value;
  }
  return { database, environment };
}

async function run(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stdio: 'inherit' | 'ignore' = 'inherit',
) {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(binary, args, { env, stdio });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(`${binary} failed with exit code ${code ?? 'signal'}`),
        );
    });
  });
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function assertPgDump16(binary: string): Promise<void> {
  const { stdout } = await execFileAsync(binary, ['--version']);
  if (!/\b16\./.test(stdout))
    throw new Error(`${binary} must be PostgreSQL 16 client tools`);
}

async function main() {
  process.umask(0o077);
  const root = resolve(process.argv[2] ?? './backups');
  const stamp = new Date().toISOString().replaceAll(/[-:.]/g, '');
  const destination = join(root, `myota-${stamp}`);
  const staging = join(root, `.myota-${stamp}-${process.pid}.partial`);
  const pgDump = process.env.PG_DUMP_PATH ?? 'pg_dump';
  await assertPgDump16(pgDump);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(staging, { mode: 0o700 });
  const databases = {} as BackupManifest['databases'];
  try {
    for (const owner of Object.keys(owners) as Owner[]) {
      const config = databaseConfig(owner);
      const file = `${owner}.dump`;
      await run(
        pgDump,
        [
          '--no-password',
          '--format=custom',
          '--no-owner',
          '--no-privileges',
          `--file=${join(staging, file)}`,
          `--dbname=${config.database}`,
        ],
        config.environment,
      );
      databases[owner] = {
        database: config.database,
        file,
        sha256: await sha256(join(staging, file)),
      };
    }
    const manifest: BackupManifest = {
      manifestVersion: 1,
      format: 'postgres-custom',
      createdAt: new Date().toISOString(),
      databases,
    };
    const manifestFile = await open(
      join(staging, 'manifest.json'),
      'wx',
      0o600,
    );
    try {
      await manifestFile.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
      await manifestFile.sync();
    } finally {
      await manifestFile.close();
    }
    await rename(staging, destination);
    process.stdout.write(`${destination}\n`);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error('Database backup failed:', error);
  process.exitCode = 1;
});
