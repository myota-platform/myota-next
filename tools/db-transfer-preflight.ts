import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const owners = {
  core: {
    sourceVariable: 'LEGACY_CORE_DATABASE_URL',
    targetVariable: 'CORE_DATABASE_URL',
    migrations: [
      '001_core_baseline.sql',
      '002_identity_auth_support.sql',
      '003_identity_auth_backfill.sql',
    ],
  },
  activity: {
    sourceVariable: 'LEGACY_ACTIVITY_DATABASE_URL',
    targetVariable: 'ACTIVITY_DATABASE_URL',
    migrations: ['001_activity_baseline.sql'],
  },
  geo: {
    sourceVariable: 'LEGACY_GEO_DATABASE_URL',
    targetVariable: 'GEO_DATABASE_URL',
    migrations: ['001_geodata_baseline.sql'],
  },
} as const;
type Owner = keyof typeof owners;
type Endpoint = {
  database: string;
  host: string;
  port: string;
  url: string;
};
type SourceMigration = {
  migration_id: string;
  checksum: string | null;
  application_mode: string;
};
type LedgerInspection =
  | { kind: 'python'; rows: SourceMigration[] }
  | { kind: 'nestjs'; rows: { migration: string }[] }
  | { kind: 'unknown' | 'missing'; rows: [] };

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsRoot = join(repositoryRoot, 'deploy', 'db', 'migrations');

async function main() {
  const endpoints = {} as Record<Owner, { source: Endpoint; target: Endpoint }>;
  for (const owner of Object.keys(owners) as Owner[]) {
    const config = owners[owner];
    endpoints[owner] = {
      source: endpoint(config.sourceVariable),
      target: endpoint(config.targetVariable),
    };
  }
  assertSixDistinctEndpoints(endpoints);

  const reports = [];
  for (const owner of Object.keys(owners) as Owner[]) {
    const { source, target } = endpoints[owner];
    const sourceClient = new Client({
      connectionString: source.url,
      application_name: `myota-transfer-preflight-${owner}-source`,
      connectionTimeoutMillis: 10_000,
    });
    const targetClient = new Client({
      connectionString: target.url,
      application_name: `myota-transfer-preflight-${owner}-target`,
      connectionTimeoutMillis: 10_000,
    });
    try {
      await sourceClient.connect();
      await targetClient.connect();
      const sourceLedger = await inspectLedger(sourceClient, owner);
      const targetLedger = await inspectLedger(targetClient, owner);
      const expectedMigrations = await expectedSourceMigrations(owner);
      assertExpectedSourceLedger(owner, sourceLedger, expectedMigrations);
      const relationCount = await targetClient.query<{ count: string }>(`
        SELECT count(*)::text AS count
          FROM pg_class AS c
          JOIN pg_namespace AS n ON n.oid=c.relnamespace
         WHERE n.nspname='public'
           AND c.relkind IN ('r','p','v','m','S','f')
           AND c.relname NOT IN (
             'myota_schema_migration', 'myota_deployment_schema_state'
           )
      `);
      reports.push({
        owner,
        source: {
          database: source.database,
          host: source.host,
          port: Number(source.port),
          migrations: sourceLedger.rows.map(
            ({ migration_id, application_mode }) => ({
              migration: migration_id,
              mode: application_mode,
            }),
          ),
          sourceHistory: 'matches-verified-python-migrations',
        },
        target: {
          database: target.database,
          host: target.host,
          port: Number(target.port),
          publicApplicationRelations: Number(relationCount.rows[0]?.count ?? 0),
          migrationLedger: targetLedger.kind,
        },
      });
    } finally {
      await Promise.allSettled([sourceClient.end(), targetClient.end()]);
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        mode: 'read-only',
        transferImplemented: false,
        sourceRepositoryBaseline:
          'myota-platform/myota@7f904a5130e59006765cf882956a4adbfecb17ec',
        ownerCount: reports.length,
        owners: reports,
        nextStep:
          'Review source ledgers and destination state. This command does not copy or change data.',
      },
      null,
      2,
    )}\n`,
  );
}

function endpoint(variable: string): Endpoint {
  const value = process.env[variable];
  if (!value) throw new Error(`${variable} is required`);
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error(`${variable} must be a PostgreSQL URL`);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database || !url.hostname)
    throw new Error(`${variable} must include a host and database`);
  return {
    database,
    host: url.hostname.toLowerCase(),
    port: url.port || '5432',
    url: value,
  };
}

function assertSixDistinctEndpoints(
  endpoints: Record<Owner, { source: Endpoint; target: Endpoint }>,
) {
  const seen = new Map<string, string>();
  for (const owner of Object.keys(owners) as Owner[]) {
    for (const [side, value] of Object.entries(endpoints[owner])) {
      const key = `${value.host}:${value.port}/${value.database}`;
      const label = `${owner} ${side}`;
      const previous = seen.get(key);
      if (previous)
        throw new Error(
          `${previous} and ${label} target the same PostgreSQL database`,
        );
      seen.set(key, label);
    }
  }
}

async function inspectLedger(
  client: Client,
  owner: Owner,
): Promise<LedgerInspection> {
  const columns = await client.query<{ column_name: string }>(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema='public' AND table_name='myota_schema_migration'
  `);
  const names = new Set(columns.rows.map((row) => row.column_name));
  if (
    ['migration_id', 'checksum', 'application_mode'].every((name) =>
      names.has(name),
    )
  ) {
    const result = await client.query<{
      migration_id: string;
      checksum: string | null;
      application_mode: string;
    }>(`
      SELECT migration_id,checksum,application_mode
        FROM public.myota_schema_migration
       ORDER BY migration_id
    `);
    return { kind: 'python', rows: result.rows } as const;
  }
  const nextLedger = ['owner', 'migration', 'checksum'].every((name) =>
    names.has(name),
  );
  if (nextLedger) {
    const result = await client.query<{ migration: string }>(
      'SELECT migration FROM public.myota_schema_migration WHERE owner=$1 ORDER BY migration',
      [owner],
    );
    return { kind: 'nestjs', rows: result.rows } as const;
  }
  return {
    kind: names.size ? 'unknown' : 'missing',
    rows: [] as [],
  } as const;
}

async function expectedSourceMigrations(owner: Owner) {
  const config = owners[owner];
  const expected = new Map<string, string>();
  for (const migration of config.migrations) {
    const directory = join(migrationsRoot, owner);
    const sql = await readFile(join(directory, migration));
    expected.set(
      migration === config.migrations[0] ? 'baseline-v1' : migration,
      createHash('sha256').update(sql).digest('hex'),
    );
  }
  return expected;
}

function assertExpectedSourceLedger(
  owner: Owner,
  ledger: LedgerInspection,
  expected: Map<string, string>,
): asserts ledger is { kind: 'python'; rows: SourceMigration[] } {
  if (ledger.kind !== 'python')
    throw new Error(`${owner} source has a non-Python migration ledger`);
  const actual = new Map(ledger.rows.map((row) => [row.migration_id, row]));
  if (
    actual.size !== expected.size ||
    [...expected.keys()].some((migration) => !actual.has(migration))
  )
    throw new Error(
      `${owner} source migration ledger differs from the verified Python history`,
    );
  for (const [migration, checksum] of expected) {
    const row = actual.get(migration);
    if (!row || row.checksum !== checksum)
      throw new Error(
        `${owner} source migration checksum differs for ${migration}`,
      );
    if (!['applied', 'adopted'].includes(row.application_mode))
      throw new Error(
        `${owner} source migration mode is unsupported for ${migration}`,
      );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Database transfer preflight failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
