import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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
    legacyEmailSource: {
      database: string;
      host: string;
      port: number;
      repositoryBaseline: string;
      migrationSha256: string;
    };
    owners: Array<{
      owner: Owner;
      target: { applicationObjects: number; migrationLedger: string };
    }>;
  };
  legacyEmailSource: {
    repositoryBaseline: string;
    migrationSha256: string;
    source: DumpEntry;
  };
  owners: Record<Owner, { source: DumpEntry; targetBackup: DumpEntry }>;
};
type RecoveryManifest = {
  manifestVersion: 1;
  format: 'postgres-custom';
  createdAt: string;
  databases: Record<Owner, { database: string; file: string; sha256: string }>;
};
type ApplyReport = {
  transferVersion: 2;
  status:
    | 'ready-to-restore'
    | 'restoring'
    | 'adopting-ledgers'
    | 'applying-migrations'
    | 'merging-email-data'
    | 'migration-complete-validation-required'
    | 'failed';
  archiveDirectory: string;
  sourceBaseline: string;
  emailSourceEndpoint: string;
  sourceFrozenAcknowledged: true;
  targetConfirmation: string;
  startedAt: string;
  updatedAt: string;
  currentOwner?: Owner;
  restoreStarted?: boolean;
  failure?: string;
  recoveryManifest?: string;
  postflight?: unknown;
  dataValidated?: false;
};

const baseline =
  'myota-platform/myota@7f904a5130e59006765cf882956a4adbfecb17ec';
const emailMigrationSha256 =
  '58b6e627141c37bbacf196f786bdc992bdb315c9d16d50b50139b4073c85c11a';

async function main() {
  process.umask(0o077);
  const archive = parseArchiveDirectory(process.argv.slice(2));
  if (process.env.MYOTA_TRANSFER_SOURCE_FROZEN !== 'YES')
    throw new Error(
      'Set MYOTA_TRANSFER_SOURCE_FROZEN=YES after stopping all Python writers',
    );
  if (process.env.MYOTA_TRANSFER_TARGET_OFFLINE !== 'YES')
    throw new Error(
      'Set MYOTA_TRANSFER_TARGET_OFFLINE=YES after stopping NestJS target writers',
    );
  const manifest = await readManifest(archive);
  const endpoints = {} as Record<Owner, { source: Endpoint; target: Endpoint }>;
  for (const owner of Object.keys(owners) as Owner[]) {
    const config = owners[owner];
    endpoints[owner] = {
      source: endpoint(config.sourceVariable, 'source', owner),
      target: endpoint(config.targetVariable, 'target', owner),
    };
    assertEndpointMatches(
      owner,
      'source',
      endpoints[owner].source,
      manifest.owners[owner].source,
    );
    assertEndpointMatches(
      owner,
      'target',
      endpoints[owner].target,
      manifest.owners[owner].targetBackup,
    );
  }
  const emailSource = endpoint('LEGACY_EMAIL_DATABASE_URL', 'source', 'email');
  assertEndpointMatches(
    'email',
    'source',
    emailSource,
    manifest.legacyEmailSource.source,
  );
  const confirmation = transferConfirmation(endpoints);
  if (process.env.MYOTA_TRANSFER_CONFIRM !== confirmation)
    throw new Error(`Set MYOTA_TRANSFER_CONFIRM to exactly: ${confirmation}`);

  const applyReportPath = join(archive, 'apply-report.json');
  await assertAbsent(applyReportPath);
  const recoveryDirectory = join(archive, 'recovery-before-apply');
  await assertAbsent(recoveryDirectory);
  const pgRestore = process.env.PG_RESTORE_PATH ?? 'pg_restore';
  const pgDump = process.env.PG_DUMP_PATH ?? 'pg_dump';
  await assertPostgres16(pgRestore, 'pg_restore');
  await assertPostgres16(pgDump, 'pg_dump');
  await verifyStagedArchives(archive, manifest, pgRestore);

  const preflight = await runPreflight();
  assertPreflightForApply(preflight, manifest, emailSource);

  await mkdir(recoveryDirectory, { mode: 0o700 });
  const recoveryEntries = {} as RecoveryManifest['databases'];
  try {
    for (const owner of Object.keys(owners) as Owner[]) {
      const target = endpoints[owner].target;
      const file = `${owner}.dump`;
      const path = join(recoveryDirectory, file);
      await dump(pgDump, target, path, owner);
      await assertArchiveReadable(pgRestore, path);
      recoveryEntries[owner] = await dumpEntry(target, file, path);
    }
    const recoveryManifest: RecoveryManifest = {
      manifestVersion: 1,
      format: 'postgres-custom',
      createdAt: new Date().toISOString(),
      databases: Object.fromEntries(
        (Object.keys(owners) as Owner[]).map((owner) => [
          owner,
          {
            database: recoveryEntries[owner].database,
            file: recoveryEntries[owner].file,
            sha256: recoveryEntries[owner].sha256,
          },
        ]),
      ) as RecoveryManifest['databases'],
    };
    await writeJsonAtomic(
      join(recoveryDirectory, 'manifest.json'),
      recoveryManifest,
    );
  } catch (error) {
    await rm(recoveryDirectory, { recursive: true, force: true });
    throw error;
  }

  const report: ApplyReport = {
    transferVersion: 2,
    status: 'ready-to-restore',
    archiveDirectory: archive,
    sourceBaseline: baseline,
    emailSourceEndpoint: endpointId(emailSource),
    sourceFrozenAcknowledged: true,
    targetConfirmation: confirmation,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    recoveryManifest: join(recoveryDirectory, 'manifest.json'),
  };
  await writeJsonAtomic(applyReportPath, report);

  try {
    report.status = 'restoring';
    report.restoreStarted = true;
    await updateReport(applyReportPath, report);
    for (const owner of Object.keys(owners) as Owner[]) {
      report.currentOwner = owner;
      await updateReport(applyReportPath, report);
      await restoreSource(
        pgRestore,
        endpoints[owner].target,
        join(archive, manifest.owners[owner].source.file),
        owner,
      );
    }

    report.status = 'adopting-ledgers';
    for (const owner of Object.keys(owners) as Owner[]) {
      report.currentOwner = owner;
      await updateReport(applyReportPath, report);
      const target = endpoints[owner].target;
      const env = {
        ...process.env,
        MYOTA_TRANSFER_LEDGER_CONFIRM: `ADOPT PYTHON LEDGER ${owner}=${endpointId(target)}`,
      };
      await run(
        process.execPath,
        [
          '--experimental-strip-types',
          'tools/db-transfer-adopt-ledger.ts',
          `--owner=${owner}`,
        ],
        env,
      );
    }

    report.status = 'applying-migrations';
    for (const owner of Object.keys(owners) as Owner[]) {
      report.currentOwner = owner;
      await updateReport(applyReportPath, report);
      await run(process.execPath, [
        '--experimental-strip-types',
        'tools/db-migrate.ts',
        `--owner=${owner}`,
      ]);
    }

    report.status = 'merging-email-data';
    report.currentOwner = undefined;
    await updateReport(applyReportPath, report);
    await restoreLegacyEmail(
      pgRestore,
      endpoints.core.target,
      join(archive, manifest.legacyEmailSource.source.file),
    );

    const postflight = await runPreflight();
    assertPostflight(postflight, manifest, emailSource);
    report.status = 'migration-complete-validation-required';
    report.currentOwner = undefined;
    report.postflight = postflight;
    report.dataValidated = false;
    await updateReport(applyReportPath, report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    report.status = 'failed';
    report.failure = error instanceof Error ? error.message : String(error);
    await updateReport(applyReportPath, report).catch(() => undefined);
    throw new Error(
      `Transfer apply failed${report.restoreStarted ? ' after target changes may have begun' : ''}. Recovery dumps: ${report.recoveryManifest}. Recreate or restore all three destinations before retrying. ${report.failure}`,
      { cause: error },
    );
  }
}

function parseArchiveDirectory(args: string[]): string {
  if (args.length !== 1 || !args[0].startsWith('--archive-dir='))
    throw new Error(
      'Usage: npm run db:transfer:apply -- --archive-dir=STAGED_DIRECTORY',
    );
  return resolve(args[0].slice('--archive-dir='.length));
}

async function readManifest(archive: string): Promise<TransferManifest> {
  const archiveInfo = await lstat(archive);
  if (!archiveInfo.isDirectory() || archiveInfo.isSymbolicLink())
    throw new Error('Archive path must be a regular directory');
  const value: unknown = JSON.parse(
    await readFile(join(archive, 'manifest.json'), 'utf8'),
  );
  if (!value || typeof value !== 'object')
    throw new Error('Transfer manifest is invalid');
  const manifest = value as Partial<TransferManifest>;
  if (
    manifest.transferVersion !== 2 ||
    manifest.format !== 'postgres-custom' ||
    manifest.sourceBaseline !== baseline ||
    !manifest.owners ||
    !manifest.preflight ||
    manifest.preflight.mode !== 'read-only' ||
    manifest.preflight.sourceRepositoryBaseline !== baseline ||
    manifest.preflight.ownerCount !== 3 ||
    !Array.isArray(manifest.preflight.owners) ||
    manifest.preflight.legacyEmailSource?.repositoryBaseline !==
      'myota-platform/myota-email-worker@be5a4d965fb8465fd0ce3c3172bde8a0af38aec1' ||
    manifest.preflight.legacyEmailSource.migrationSha256 !==
      emailMigrationSha256 ||
    manifest.legacyEmailSource?.repositoryBaseline !==
      manifest.preflight.legacyEmailSource.repositoryBaseline ||
    manifest.legacyEmailSource.migrationSha256 !== emailMigrationSha256
  )
    throw new Error('Transfer manifest does not match the verified baseline');
  for (const owner of Object.keys(owners) as Owner[]) {
    const ownerManifest = manifest.owners[owner];
    if (!ownerManifest)
      throw new Error(`Transfer manifest is missing ${owner}`);
    assertDumpEntry(ownerManifest.source, `${owner}-source.dump`);
    assertDumpEntry(ownerManifest.targetBackup, `${owner}-target-before.dump`);
  }
  assertDumpEntry(manifest.legacyEmailSource.source, 'email-source.dump');
  if (
    manifest.legacyEmailSource.source.database !==
      manifest.preflight.legacyEmailSource.database ||
    manifest.legacyEmailSource.source.host !==
      manifest.preflight.legacyEmailSource.host ||
    manifest.legacyEmailSource.source.port !==
      manifest.preflight.legacyEmailSource.port
  )
    throw new Error(
      'Email source dump endpoint differs from its staged preflight report',
    );
  return manifest as TransferManifest;
}

function assertDumpEntry(
  value: unknown,
  expectedFile: string,
): asserts value is DumpEntry {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as DumpEntry).file !== expectedFile ||
    typeof (value as DumpEntry).database !== 'string' ||
    typeof (value as DumpEntry).host !== 'string' ||
    !Number.isSafeInteger((value as DumpEntry).port) ||
    !/^[a-f0-9]{64}$/.test((value as DumpEntry).sha256)
  )
    throw new Error(`Transfer manifest entry is invalid: ${expectedFile}`);
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

function assertEndpointMatches(
  owner: string,
  side: 'source' | 'target',
  endpoint: Endpoint,
  entry: DumpEntry,
) {
  if (
    endpoint.database !== entry.database ||
    endpoint.host !== entry.host ||
    Number(endpoint.port) !== entry.port
  )
    throw new Error(
      `${owner} ${side} endpoint differs from the staged transfer manifest`,
    );
}

function endpointId(endpoint: Endpoint) {
  return `${endpoint.host}:${endpoint.port}/${endpoint.database}`;
}

function transferConfirmation(
  endpoints: Record<Owner, { source: Endpoint; target: Endpoint }>,
) {
  return `TRANSFER core=${endpointId(endpoints.core.target)} activity=${endpointId(endpoints.activity.target)} geo=${endpointId(endpoints.geo.target)}`;
}

async function verifyStagedArchives(
  archive: string,
  manifest: TransferManifest,
  pgRestore: string,
) {
  for (const owner of Object.keys(owners) as Owner[]) {
    for (const entry of [
      manifest.owners[owner].source,
      manifest.owners[owner].targetBackup,
    ]) {
      const path = join(archive, entry.file);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error(`${entry.file} must be a regular archive file`);
      if ((await sha256(path)) !== entry.sha256)
        throw new Error(`${entry.file} checksum differs from manifest`);
      await assertArchiveReadable(pgRestore, path);
    }
  }
  const emailEntry = manifest.legacyEmailSource.source;
  const emailPath = join(archive, emailEntry.file);
  const emailInfo = await lstat(emailPath);
  if (!emailInfo.isFile() || emailInfo.isSymbolicLink())
    throw new Error(`${emailEntry.file} must be a regular archive file`);
  if ((await sha256(emailPath)) !== emailEntry.sha256)
    throw new Error(`${emailEntry.file} checksum differs from manifest`);
  await assertArchiveReadable(pgRestore, emailPath);
}

async function runPreflight() {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--experimental-strip-types', 'tools/db-transfer-preflight.ts'],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const value: unknown = JSON.parse(stdout);
  if (!value || typeof value !== 'object')
    throw new Error('Transfer preflight did not return a JSON report');
  return value as TransferManifest['preflight'];
}

function assertPreflightForApply(
  report: TransferManifest['preflight'],
  manifest: TransferManifest,
  emailSource: Endpoint,
) {
  if (
    report.mode !== 'read-only' ||
    report.sourceRepositoryBaseline !== baseline ||
    report.ownerCount !== 3 ||
    report.owners.length !== 3
  )
    throw new Error('Live preflight does not match the staged baseline');
  for (const owner of Object.keys(owners) as Owner[]) {
    const live = report.owners.find((item) => item.owner === owner);
    if (!live || live.target.applicationObjects !== 0)
      throw new Error(
        `${owner} destination must have no application relations before transfer`,
      );
    const staged = manifest.preflight.owners.find(
      (item) => item.owner === owner,
    );
    if (!staged) throw new Error(`Staged preflight is missing ${owner}`);
  }
  if (
    report.legacyEmailSource.database !== emailSource.database ||
    report.legacyEmailSource.host !== emailSource.host ||
    report.legacyEmailSource.port !== Number(emailSource.port) ||
    report.legacyEmailSource.repositoryBaseline !==
      manifest.legacyEmailSource.repositoryBaseline ||
    report.legacyEmailSource.migrationSha256 !==
      manifest.preflight.legacyEmailSource.migrationSha256
  )
    throw new Error('Live legacy email source differs from staged preflight');
}

function assertPostflight(
  report: TransferManifest['preflight'],
  manifest: TransferManifest,
  emailSource: Endpoint,
) {
  if (
    report.mode !== 'read-only' ||
    report.sourceRepositoryBaseline !== baseline ||
    report.ownerCount !== 3 ||
    report.owners.length !== 3
  )
    throw new Error('Postflight does not match the verified baseline');
  for (const owner of Object.keys(owners) as Owner[]) {
    const result = report.owners.find((item) => item.owner === owner);
    if (!result || result.target.migrationLedger !== 'nestjs')
      throw new Error(
        `${owner} postflight did not find the NestJS migration ledger`,
      );
  }
  if (
    report.legacyEmailSource.database !== emailSource.database ||
    report.legacyEmailSource.host !== emailSource.host ||
    report.legacyEmailSource.port !== Number(emailSource.port) ||
    report.legacyEmailSource.repositoryBaseline !==
      manifest.legacyEmailSource.repositoryBaseline ||
    report.legacyEmailSource.migrationSha256 !== emailMigrationSha256
  )
    throw new Error(
      'Postflight legacy email source differs from the staged source',
    );
}

async function restoreLegacyEmail(
  binary: string,
  coreTarget: Endpoint,
  emailArchive: string,
) {
  await run(
    binary,
    [
      '--data-only',
      '--exit-on-error',
      '--single-transaction',
      '--no-owner',
      '--no-privileges',
      `--dbname=${coreTarget.database}`,
      emailArchive,
    ],
    coreTarget.environment,
  );
  process.stdout.write('Merged legacy email delivery state into Core\n');
}

async function dump(
  binary: string,
  endpoint: Endpoint,
  output: string,
  owner: Owner,
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
  process.stdout.write(`Backed up ${owner} destination before apply\n`);
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

async function restoreSource(
  binary: string,
  target: Endpoint,
  sourceArchive: string,
  owner: Owner,
) {
  await run(
    binary,
    [
      '--clean',
      '--if-exists',
      '--exit-on-error',
      '--single-transaction',
      '--no-owner',
      '--no-tablespaces',
      `--dbname=${target.database}`,
      sourceArchive,
    ],
    target.environment,
  );
  process.stdout.write(`Restored ${owner} source database\n`);
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function assertPostgres16(binary: string, name: string) {
  const { stdout } = await execFileAsync(binary, ['--version']);
  if (!/\b16\./.test(stdout))
    throw new Error(`${name} must be PostgreSQL 16 client tools`);
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
    throw new Error(`Path already exists: ${path}`);
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

async function writeJsonAtomic(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}

async function updateReport(path: string, report: ApplyReport) {
  report.updatedAt = new Date().toISOString();
  await writeJsonAtomic(path, report);
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
    `Database transfer apply failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
