import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const owners = {
  core: {
    sourceVariable: 'LEGACY_CORE_DATABASE_URL',
    targetVariable: 'CORE_DATABASE_URL',
  },
  activity: {
    sourceVariable: 'LEGACY_ACTIVITY_DATABASE_URL',
    targetVariable: 'ACTIVITY_DATABASE_URL',
  },
  geo: {
    sourceVariable: 'LEGACY_GEO_DATABASE_URL',
    targetVariable: 'GEO_DATABASE_URL',
  },
} as const;
type Owner = keyof typeof owners;
const emailMigrationSha256 =
  '58b6e627141c37bbacf196f786bdc992bdb315c9d16d50b50139b4073c85c11a';
type Endpoint = {
  database: string;
  host: string;
  port: string;
  environment: NodeJS.ProcessEnv;
};
type DumpEntry = {
  database: string;
  host: string;
  port: number;
  file: string;
  sha256: string;
};
type TransferManifest = {
  transferVersion: 2;
  format: 'postgres-custom';
  sourceBaseline: string;
  createdAt: string;
  preflight: {
    mode: 'read-only';
    sourceRepositoryBaseline: string;
    ownerCount: number;
    owners: unknown[];
    legacyEmailSource: {
      database: string;
      host: string;
      port: number;
      repositoryBaseline: string;
      migrationSha256: string;
      tables: Array<{ table: string; rows: string }>;
    };
  };
  legacyEmailSource: {
    repositoryBaseline: string;
    migrationSha256: string;
    source: DumpEntry;
  };
  owners: Record<Owner, { source: DumpEntry; targetBackup: DumpEntry }>;
};

async function main() {
  process.umask(0o077);
  if (process.env.MYOTA_TRANSFER_SOURCE_FROZEN !== 'YES')
    throw new Error(
      'Set MYOTA_TRANSFER_SOURCE_FROZEN=YES after stopping all Python writers',
    );
  const destination = parseArchiveDirectory(process.argv.slice(2));
  const stamp = new Date().toISOString().replaceAll(/[-:.]/g, '');
  const staging = join(
    dirname(destination),
    `.${basename(destination)}-${stamp}-${process.pid}.partial`,
  );
  const pgDump = process.env.PG_DUMP_PATH ?? 'pg_dump';
  const pgRestore = process.env.PG_RESTORE_PATH ?? 'pg_restore';
  await assertPgDump16(pgDump);
  await assertPgRestore16(pgRestore);
  await assertAbsent(destination);

  const endpoints = {} as Record<Owner, { source: Endpoint; target: Endpoint }>;
  for (const owner of Object.keys(owners) as Owner[]) {
    const config = owners[owner];
    endpoints[owner] = {
      source: endpoint(config.sourceVariable, 'source', owner),
      target: endpoint(config.targetVariable, 'target', owner),
    };
  }
  const emailSource = endpoint('LEGACY_EMAIL_DATABASE_URL', 'source', 'email');

  const { stdout: preflightOutput } = await execFileAsync(
    process.execPath,
    ['--experimental-strip-types', 'tools/db-transfer-preflight.ts'],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const preflight = parsePreflight(preflightOutput);
  process.stdout.write(`${JSON.stringify(preflight, null, 2)}\n`);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await mkdir(staging, { mode: 0o700 });
  const ownerEntries = {} as TransferManifest['owners'];
  try {
    for (const owner of Object.keys(owners) as Owner[]) {
      const { source, target } = endpoints[owner];
      const sourceFile = `${owner}-source.dump`;
      const targetFile = `${owner}-target-before.dump`;
      await dump(pgDump, source, join(staging, sourceFile), owner, 'source');
      await dump(
        pgDump,
        target,
        join(staging, targetFile),
        owner,
        'target-backup',
      );
      await assertArchiveReadable(pgRestore, join(staging, sourceFile));
      await assertArchiveReadable(pgRestore, join(staging, targetFile));
      ownerEntries[owner] = {
        source: await dumpEntry(source, sourceFile, join(staging, sourceFile)),
        targetBackup: await dumpEntry(
          target,
          targetFile,
          join(staging, targetFile),
        ),
      };
    }

    const emailFile = 'email-source.dump';
    await dump(
      pgDump,
      emailSource,
      join(staging, emailFile),
      'email',
      'source',
    );
    await assertArchiveReadable(pgRestore, join(staging, emailFile));

    const manifest: TransferManifest = {
      transferVersion: 2,
      format: 'postgres-custom',
      sourceBaseline:
        'myota-platform/myota@7f904a5130e59006765cf882956a4adbfecb17ec',
      createdAt: new Date().toISOString(),
      preflight,
      legacyEmailSource: {
        repositoryBaseline: preflight.legacyEmailSource.repositoryBaseline,
        migrationSha256: preflight.legacyEmailSource.migrationSha256,
        source: await dumpEntry(
          emailSource,
          emailFile,
          join(staging, emailFile),
        ),
      },
      owners: ownerEntries,
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

function parsePreflight(output: string): TransferManifest['preflight'] {
  const value: unknown = JSON.parse(output);
  if (!value || typeof value !== 'object')
    throw new Error('Preflight did not return a JSON report');
  const report = value as Partial<TransferManifest['preflight']>;
  if (
    report.mode !== 'read-only' ||
    report.sourceRepositoryBaseline !==
      'myota-platform/myota@7f904a5130e59006765cf882956a4adbfecb17ec' ||
    report.ownerCount !== 3 ||
    !Array.isArray(report.owners) ||
    report.owners.length !== 3 ||
    report.legacyEmailSource?.repositoryBaseline !==
      'myota-platform/myota-email-worker@be5a4d965fb8465fd0ce3c3172bde8a0af38aec1' ||
    report.legacyEmailSource.migrationSha256 !== emailMigrationSha256
  )
    throw new Error(
      'Preflight report does not match the expected three owners',
    );
  return report as TransferManifest['preflight'];
}

function parseArchiveDirectory(args: string[]): string {
  if (args.length !== 1 || !args[0].startsWith('--archive-dir='))
    throw new Error(
      'Usage: npm run db:transfer:stage -- --archive-dir=NEW_DIRECTORY',
    );
  const destination = resolve(args[0].slice('--archive-dir='.length));
  if (destination === dirname(destination))
    throw new Error('Archive directory must not be a filesystem root');
  return destination;
}

function endpoint(
  variable: string,
  side: 'source' | 'target',
  owner: Owner | 'email',
): Endpoint {
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
    PGAPPNAME: `myota-transfer-${side}-${owner}`,
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
  return {
    database,
    host: url.hostname.toLowerCase(),
    port: url.port || '5432',
    environment,
  };
}

async function dump(
  binary: string,
  endpoint: Endpoint,
  output: string,
  owner: string,
  side: string,
) {
  await run(
    binary,
    [
      '--no-password',
      '--format=custom',
      '--no-owner',
      `--file=${output}`,
      `--dbname=${endpoint.database}`,
    ],
    endpoint.environment,
  );
  process.stdout.write(`Staged ${owner} ${side} database\n`);
}

async function dumpEntry(
  endpoint: Endpoint,
  file: string,
  path: string,
): Promise<DumpEntry> {
  return {
    database: endpoint.database,
    host: endpoint.host,
    port: Number(endpoint.port),
    file,
    sha256: await sha256(path),
  };
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function assertPgDump16(binary: string) {
  const { stdout } = await execFileAsync(binary, ['--version']);
  if (!/\b16\./.test(stdout))
    throw new Error(`${binary} must be PostgreSQL 16 client tools`);
}

async function assertPgRestore16(binary: string) {
  const { stdout } = await execFileAsync(binary, ['--version']);
  if (!/\b16\./.test(stdout))
    throw new Error(`${binary} must be PostgreSQL 16 client tools`);
}

async function assertArchiveReadable(binary: string, archive: string) {
  const { stdout } = await execFileAsync(binary, ['--list', archive], {
    maxBuffer: 4 * 1024 * 1024,
  });
  if (!stdout.trim()) throw new Error(`Backup archive is empty: ${archive}`);
}

async function assertAbsent(path: string) {
  try {
    await lstat(path);
    throw new Error(`Archive directory already exists: ${path}`);
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    )
      return;
    throw error;
  }
}

async function run(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(binary, args, { env, stdio: 'inherit' });
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

main().catch((error: unknown) => {
  process.stderr.write(
    `Database transfer staging failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
