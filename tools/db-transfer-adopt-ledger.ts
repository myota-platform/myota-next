import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const owners = {
  core: {
    variable: 'CORE_DATABASE_URL',
    sentinel: 'public.account',
    migrations: [
      '001_core_baseline.sql',
      '002_identity_auth_support.sql',
      '003_identity_auth_backfill.sql',
    ],
  },
  activity: {
    variable: 'ACTIVITY_DATABASE_URL',
    sentinel: 'public.activity_activation',
    migrations: ['001_activity_baseline.sql'],
  },
  geo: {
    variable: 'GEO_DATABASE_URL',
    sentinel: 'public.geodata_entity',
    migrations: ['001_geodata_baseline.sql'],
  },
} as const;
type Owner = keyof typeof owners;
type LegacyMigration = {
  migration_id: string;
  checksum: string | null;
  application_mode: string;
  applied_at: Date;
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const owner = parseOwner(process.argv.slice(2));
  const config = owners[owner];
  const url = process.env[config.variable];
  if (!url) throw new Error(`${config.variable} is required`);
  const parsedUrl = new URL(url);
  if (!['postgres:', 'postgresql:'].includes(parsedUrl.protocol))
    throw new Error(`${config.variable} must be a PostgreSQL URL`);
  const database = decodeURIComponent(parsedUrl.pathname.replace(/^\//, ''));
  if (!database || !parsedUrl.hostname)
    throw new Error(`${config.variable} must include a host and database`);
  const target = `${parsedUrl.hostname.toLowerCase()}:${parsedUrl.port || '5432'}/${database}`;
  const confirmation = `ADOPT PYTHON LEDGER ${owner}=${target}`;
  if (process.env.MYOTA_TRANSFER_LEDGER_CONFIRM !== confirmation)
    throw new Error(
      `Set MYOTA_TRANSFER_LEDGER_CONFIRM to exactly: ${confirmation}`,
    );

  const expected = await expectedMigrations(owner);
  const client = new Client({
    connectionString: url,
    application_name: `myota-transfer-adopt-ledger-${owner}`,
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('myota:transfer-ledger:' || $1,0))",
      [owner],
    );
    const sentinel = await client.query<{ relation: string | null }>(
      'SELECT to_regclass($1)::text AS relation',
      [config.sentinel],
    );
    if (!sentinel.rows[0]?.relation)
      throw new Error(`${owner} destination is missing ${config.sentinel}`);
    const columns = await client.query<{ column_name: string }>(`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_schema='public' AND table_name='myota_schema_migration'
    `);
    const names = new Set(columns.rows.map((row) => row.column_name));
    if (['owner', 'migration', 'checksum'].every((name) => names.has(name))) {
      const entries = await client.query<{
        migration: string;
        checksum: string;
      }>(
        'SELECT migration,checksum FROM public.myota_schema_migration WHERE owner=$1',
        [owner],
      );
      assertNestLedger(owner, entries.rows, expected);
      await client.query('COMMIT');
      process.stdout.write(`${owner} ledger is already in NestJS format\n`);
      return;
    }
    if (
      !['migration_id', 'checksum', 'application_mode', 'applied_at'].every(
        (name) => names.has(name),
      )
    )
      throw new Error(`${owner} migration ledger has an unknown schema`);

    const legacy = await client.query<LegacyMigration>(`
      SELECT migration_id,checksum,application_mode,applied_at
        FROM public.myota_schema_migration
       ORDER BY migration_id
    `);
    const mapped = assertPythonLedger(owner, legacy.rows, expected);
    await client.query(`
      CREATE TEMP TABLE myota_transfer_migration_ledger (
        owner text NOT NULL,
        migration text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL,
        PRIMARY KEY (owner,migration)
      ) ON COMMIT DROP
    `);
    for (const row of mapped)
      await client.query(
        `INSERT INTO myota_transfer_migration_ledger
         (owner,migration,checksum,applied_at) VALUES ($1,$2,$3,$4)`,
        [owner, row.migration, row.checksum, row.appliedAt],
      );
    await client.query('DROP TABLE public.myota_schema_migration');
    await client.query(`
      CREATE TABLE public.myota_schema_migration (
        owner text NOT NULL,
        migration text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (owner,migration)
      )
    `);
    await client.query(`
      INSERT INTO public.myota_schema_migration(owner,migration,checksum,applied_at)
      SELECT owner,migration,checksum,applied_at
        FROM myota_transfer_migration_ledger
    `);
    await client.query('COMMIT');
    process.stdout.write(
      `Converted ${owner} migration ledger for ${target}; run the owner migration command next.\n`,
    );
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

function parseOwner(args: string[]): Owner {
  if (args.length !== 1 || !args[0].startsWith('--owner='))
    throw new Error(
      'Usage: npm run db:transfer:adopt-ledger -- --owner=core|activity|geo',
    );
  const owner = args[0].slice('--owner='.length);
  if (owner !== 'core' && owner !== 'activity' && owner !== 'geo')
    throw new Error('Owner must be core, activity, or geo');
  return owner;
}

async function expectedMigrations(owner: Owner) {
  const expected = new Map<string, string>();
  for (const [index, migration] of owners[owner].migrations.entries()) {
    const sql = await readFile(
      join(root, 'deploy', 'db', 'migrations', owner, migration),
    );
    expected.set(
      index === 0 ? 'baseline-v1' : migration,
      createHash('sha256').update(sql).digest('hex'),
    );
  }
  return expected;
}

function assertPythonLedger(
  owner: Owner,
  rows: LegacyMigration[],
  expected: Map<string, string>,
) {
  const actual = new Map(rows.map((row) => [row.migration_id, row]));
  if (
    actual.size !== expected.size ||
    [...expected.keys()].some((migration) => !actual.has(migration))
  )
    throw new Error(
      `${owner} ledger differs from the verified Python migration history`,
    );
  return [...expected].map(([migrationId, checksum]) => {
    const row = actual.get(migrationId);
    if (!row || row.checksum !== checksum)
      throw new Error(`${owner} source checksum differs for ${migrationId}`);
    if (!['applied', 'adopted'].includes(row.application_mode))
      throw new Error(
        `${owner} migration mode is unsupported for ${migrationId}`,
      );
    return {
      migration:
        migrationId === 'baseline-v1'
          ? owners[owner].migrations[0]
          : migrationId,
      checksum,
      appliedAt: row.applied_at,
    };
  });
}

function assertNestLedger(
  owner: Owner,
  rows: { migration: string; checksum: string }[],
  expected: Map<string, string>,
) {
  const actual = new Map(rows.map((row) => [row.migration, row.checksum]));
  for (const [legacyId, checksum] of expected) {
    const migration =
      legacyId === 'baseline-v1' ? owners[owner].migrations[0] : legacyId;
    if (actual.get(migration) !== checksum)
      throw new Error(
        `${owner} NestJS ledger is missing or has a different checksum for ${migration}`,
      );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Migration ledger adoption failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
