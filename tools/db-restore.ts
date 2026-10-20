import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
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

type BackupEntry = { database: string; file: string; sha256: string };
type BackupManifest = {
  manifestVersion: number;
  format: string;
  createdAt: string;
  databases: Record<string, BackupEntry>;
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
    PGAPPNAME: `myota-${owner}-restore`,
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

async function assertPgRestore16(binary: string): Promise<void> {
  const { stdout } = await execFileAsync(binary, ['--version']);
  if (!/\b16\./.test(stdout))
    throw new Error(`${binary} must be PostgreSQL 16 client tools`);
}

function validManifest(value: unknown): value is BackupManifest {
  if (!value || typeof value !== 'object') return false;
  const manifest = value as Partial<BackupManifest>;
  if (
    manifest.manifestVersion !== 1 ||
    manifest.format !== 'postgres-custom' ||
    typeof manifest.createdAt !== 'string' ||
    !manifest.databases ||
    typeof manifest.databases !== 'object'
  )
    return false;
  return (Object.keys(owners) as Owner[]).every((owner) => {
    const entry = manifest.databases?.[owner];
    return (
      !!entry &&
      typeof entry.database === 'string' &&
      entry.file === `${owner}.dump` &&
      /^[a-f0-9]{64}$/.test(entry.sha256)
    );
  });
}

async function main() {
  process.umask(0o077);
  const backup = resolve(process.argv[2] ?? '');
  if (!process.argv[2])
    throw new Error('Usage: npm run db:restore -- BACKUP_DIRECTORY');
  const confirmation = `RESTORE ${basename(backup)}`;
  if (process.env.MYOTA_RESTORE_CONFIRM !== confirmation)
    throw new Error(`Set MYOTA_RESTORE_CONFIRM to exactly: ${confirmation}`);

  const manifestPath = join(backup, 'manifest.json');
  const manifestValue: unknown = JSON.parse(
    await readFile(manifestPath, 'utf8'),
  );
  if (!validManifest(manifestValue))
    throw new Error('Backup manifest is invalid or incomplete');
  const manifest = manifestValue;
  const pgRestore = process.env.PG_RESTORE_PATH ?? 'pg_restore';
  await assertPgRestore16(pgRestore);

  const configs = {} as Record<Owner, DatabaseConfig>;
  for (const owner of Object.keys(owners) as Owner[]) {
    const entry = manifest.databases[owner];
    const dumpPath = join(backup, entry.file);
    const info = await lstat(dumpPath);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`${entry.file} must be a regular backup file`);
    if ((await sha256(dumpPath)) !== entry.sha256)
      throw new Error(`${entry.file} checksum does not match the manifest`);
    configs[owner] = databaseConfig(owner);
    if (configs[owner].database !== entry.database)
      throw new Error(
        `${owners[owner]} targets ${configs[owner].database}; backup owner ${owner} requires ${entry.database}`,
      );
    await run(
      pgRestore,
      ['--list', dumpPath],
      configs[owner].environment,
      'ignore',
    );
  }

  process.stderr.write(
    `Restoring all three databases from ${basename(backup)}. Each database is transactional; a later owner failure does not roll back earlier databases.\n`,
  );
  for (const owner of Object.keys(owners) as Owner[]) {
    const entry = manifest.databases[owner];
    await run(
      pgRestore,
      [
        '--clean',
        '--if-exists',
        '--exit-on-error',
        '--single-transaction',
        '--no-owner',
        '--no-privileges',
        `--dbname=${configs[owner].database}`,
        join(backup, entry.file),
      ],
      configs[owner].environment,
    );
    process.stdout.write(`Restored ${owner}/${entry.database}\n`);
  }
}

main().catch((error: unknown) => {
  console.error('Database restore failed:', error);
  process.exitCode = 1;
});
