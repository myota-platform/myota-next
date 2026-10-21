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
const legacyEmail = {
  sourceVariable: 'LEGACY_EMAIL_DATABASE_URL',
  repositoryBaseline:
    'myota-platform/myota-email-worker@be5a4d965fb8465fd0ce3c3172bde8a0af38aec1',
  migrationSha256:
    '58b6e627141c37bbacf196f786bdc992bdb315c9d16d50b50139b4073c85c11a',
  tables: {
    email_delivery: [
      'work_id',
      'template_id',
      'status',
      'attempts',
      'lease_until',
      'last_error_code',
      'received_at',
      'delivered_at',
      'created_at',
      'updated_at',
    ],
    email_delivery_attempt: [
      'id',
      'work_id',
      'outcome',
      'error_code',
      'attempted_at',
    ],
    email_dead_letter: [
      'id',
      'work_id',
      'error_code',
      'recorded_at',
      'redrive_requested_at',
      'redrive_actor',
      'redrive_reason',
      'resolved_at',
    ],
    email_dead_letter_redrive: [
      'id',
      'work_id',
      'error_code',
      'actor',
      'reason',
      'requested_at',
    ],
  },
} as const;
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
  const emailSource = endpoint(legacyEmail.sourceVariable);
  assertSevenDistinctEndpoints(endpoints, emailSource);

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
      if (owner === 'core') await assertNoLegacyEmailTables(sourceClient);
      const sourceLedger = await inspectLedger(sourceClient, owner);
      const targetLedger = await inspectLedger(targetClient, owner);
      const expectedMigrations = await expectedSourceMigrations(owner);
      assertExpectedSourceLedger(owner, sourceLedger, expectedMigrations);
      const sourceAclRoles = await aclRoles(sourceClient);
      const targetAclRoles = await aclRoles(targetClient);
      const missingTargetRoles = sourceAclRoles.filter(
        (role) => !targetAclRoles.includes(role),
      );
      if (missingTargetRoles.length)
        throw new Error(
          `${owner} destination is missing source ACL roles: ${missingTargetRoles.join(', ')}`,
        );
      if (owner === 'geo')
        await assertGeoExtensionsAvailable(sourceClient, targetClient);
      const objectCount = await targetClient.query<{ count: string }>(`
        WITH application_objects AS (
          SELECT n.nspname AS schema_name,c.relname AS object_name
            FROM pg_class AS c
            JOIN pg_namespace AS n ON n.oid=c.relnamespace
           WHERE n.nspname NOT IN ('pg_catalog','information_schema')
             AND n.nspname !~ '^pg_'
             AND c.relkind IN ('r','p','v','m','S','f')
             AND NOT (
               n.nspname='public'
               AND c.relname IN (
                 'myota_schema_migration',
                 'myota_nest_schema_migration',
                 'myota_deployment_schema_state'
               )
             )
             AND NOT EXISTS (
               SELECT 1 FROM pg_depend AS d
                WHERE d.classid='pg_class'::regclass
                  AND d.objid=c.oid
                  AND d.deptype='e'
             )
          UNION ALL
          SELECT n.nspname,p.proname
            FROM pg_proc AS p
            JOIN pg_namespace AS n ON n.oid=p.pronamespace
           WHERE n.nspname NOT IN ('pg_catalog','information_schema')
             AND n.nspname !~ '^pg_'
             AND NOT EXISTS (
               SELECT 1 FROM pg_depend AS d
                WHERE d.classid='pg_proc'::regclass
                  AND d.objid=p.oid
                  AND d.deptype='e'
             )
          UNION ALL
          SELECT n.nspname,t.typname
            FROM pg_type AS t
            JOIN pg_namespace AS n ON n.oid=t.typnamespace
           WHERE n.nspname NOT IN ('pg_catalog','information_schema')
             AND n.nspname !~ '^pg_'
             AND t.typrelid=0 AND t.typelem=0 AND t.typtype<>'p'
             AND NOT EXISTS (
               SELECT 1 FROM pg_depend AS d
                WHERE d.classid='pg_type'::regclass
                  AND d.objid=t.oid
                  AND d.deptype='e'
             )
          UNION ALL
          SELECT n.nspname,'<schema>'
            FROM pg_namespace AS n
           WHERE n.nspname NOT IN ('public','pg_catalog','information_schema')
             AND n.nspname !~ '^pg_'
             AND NOT EXISTS (
               SELECT 1 FROM pg_depend AS d
                WHERE d.classid='pg_namespace'::regclass
                  AND d.objid=n.oid
                  AND d.deptype='e'
             )
        )
        SELECT count(*)::text AS count FROM application_objects
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
          aclRoles: sourceAclRoles,
          sourceHistory: 'matches-verified-python-migrations',
        },
        target: {
          database: target.database,
          host: target.host,
          port: Number(target.port),
          applicationObjects: Number(objectCount.rows[0]?.count ?? 0),
          migrationLedger: targetLedger.kind,
          aclRoles: targetAclRoles,
        },
      });
    } finally {
      await Promise.allSettled([sourceClient.end(), targetClient.end()]);
    }
  }

  const emailReport = await inspectLegacyEmailSource(emailSource);

  process.stdout.write(
    `${JSON.stringify(
      {
        mode: 'read-only',
        thisCommandCopiesData: false,
        dumpStagingImplemented: true,
        transferApplyImplemented: true,
        sourceRepositoryBaseline:
          'myota-platform/myota@7f904a5130e59006765cf882956a4adbfecb17ec',
        ownerCount: reports.length,
        owners: reports,
        legacyEmailSource: emailReport,
        nextStep:
          'Review all four source databases and three destinations. This command does not copy or change data.',
      },
      null,
      2,
    )}\n`,
  );
}

async function aclRoles(client: Client): Promise<string[]> {
  const result = await client.query<{ rolname: string }>(`
    WITH acl_lists AS (
      SELECT n.nspacl AS acl
        FROM pg_namespace AS n
       WHERE n.nspname='public' AND n.nspacl IS NOT NULL
      UNION ALL
      SELECT c.relacl AS acl
        FROM pg_class AS c
        JOIN pg_namespace AS n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relacl IS NOT NULL
      UNION ALL
      SELECT p.proacl AS acl
        FROM pg_proc AS p
        JOIN pg_namespace AS n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proacl IS NOT NULL
      UNION ALL
      SELECT d.defaclacl AS acl
        FROM pg_default_acl AS d
       WHERE d.defaclnamespace='public'::regnamespace
         AND d.defaclacl IS NOT NULL
    ), acl_principals AS (
      SELECT privilege.grantee AS role_oid
        FROM acl_lists
        CROSS JOIN LATERAL aclexplode(acl_lists.acl) AS privilege
      UNION
      SELECT privilege.grantor AS role_oid
        FROM acl_lists
        CROSS JOIN LATERAL aclexplode(acl_lists.acl) AS privilege
    )
    SELECT DISTINCT role.rolname
      FROM acl_principals AS principal
      JOIN pg_roles AS role ON role.oid=principal.role_oid
     WHERE principal.role_oid<>0
     ORDER BY role.rolname
  `);
  return result.rows.map((row) => row.rolname);
}

async function assertGeoExtensionsAvailable(source: Client, target: Client) {
  const required = [
    'fuzzystrmatch',
    'pgcrypto',
    'postgis',
    'postgis_tiger_geocoder',
    'postgis_topology',
  ];
  const sourceInstalled = await source.query<{
    name: string;
    version: string;
  }>(
    `
    SELECT extname AS name,extversion AS version
      FROM pg_extension
     WHERE extname=ANY($1::text[])
     ORDER BY extname
  `,
    [required],
  );
  const versions = new Map(
    sourceInstalled.rows.map(({ name, version }) => [name, version]),
  );
  const missingSource = required.filter((name) => !versions.has(name));
  if (missingSource.length)
    throw new Error(
      `Geodata source database is missing required extensions: ${missingSource.join(', ')}`,
    );

  const targetAvailable = await target.query<{
    name: string;
    version: string;
  }>(
    `
    SELECT name,version
      FROM pg_available_extension_versions
     WHERE name=ANY($1::text[])
  `,
    [required],
  );
  const available = new Set(
    targetAvailable.rows.map(({ name, version }) => `${name}@${version}`),
  );
  const missingTarget = required.filter(
    (name) => !available.has(`${name}@${versions.get(name)}`),
  );
  if (missingTarget.length)
    throw new Error(
      `Geodata destination server does not provide source extension versions: ${missingTarget.map((name) => `${name}@${versions.get(name)}`).join(', ')}`,
    );
}

async function inspectLegacyEmailSource(source: Endpoint) {
  const client = new Client({
    connectionString: source.url,
    application_name: 'myota-transfer-preflight-email-source',
    connectionTimeoutMillis: 10_000,
  });
  try {
    await client.connect();
    const tables = await client.query<{ table_name: string }>(`
      SELECT c.relname AS table_name
        FROM pg_class AS c
        JOIN pg_namespace AS n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT c.relispartition
       ORDER BY c.relname
    `);
    const expectedNames = Object.keys(legacyEmail.tables).sort();
    const actualNames = tables.rows.map(({ table_name }) => table_name);
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames))
      throw new Error(
        `Legacy email database tables differ from the verified schema: ${actualNames.join(', ')}`,
      );
    const tableReports = [];
    for (const [table, expectedColumns] of Object.entries(legacyEmail.tables)) {
      const columnResult = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
        [table],
      );
      const actualColumns = columnResult.rows.map(
        ({ column_name }) => column_name,
      );
      if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns))
        throw new Error(
          `Legacy email table ${table} columns differ from the verified schema`,
        );
      const countResult = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM public.${quoteIdentifier(table)}`,
      );
      tableReports.push({
        table,
        rows: countResult.rows[0]?.count ?? '0',
      });
    }
    const emailMigration = await readFile(
      join(
        repositoryRoot,
        'docs/reference/migrations/app-migrations/email/001_email_delivery.sql',
      ),
    );
    const coreEmailMigration = await readFile(
      join(
        repositoryRoot,
        'deploy/db/migrations/core/005_identity_email_delivery.sql',
      ),
    );
    const emailMigrationSha256 = createHash('sha256')
      .update(emailMigration)
      .digest('hex');
    if (
      emailMigrationSha256 !== legacyEmail.migrationSha256 ||
      createHash('sha256').update(coreEmailMigration).digest('hex') !==
        legacyEmail.migrationSha256
    )
      throw new Error(
        'Email migration does not match the pinned legacy email schema',
      );
    return {
      database: source.database,
      host: source.host,
      port: Number(source.port),
      repositoryBaseline: legacyEmail.repositoryBaseline,
      migrationSha256: emailMigrationSha256,
      tables: tableReports,
    };
  } finally {
    await client.end();
  }
}

async function assertNoLegacyEmailTables(client: Client) {
  const result = await client.query<{ table_name: string }>(
    `
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema='public'
       AND table_name=ANY($1::text[])
     ORDER BY table_name
  `,
    [Object.keys(legacyEmail.tables)],
  );
  if (result.rows.length)
    throw new Error(
      `Legacy Core already contains email delivery tables (${result.rows.map(({ table_name }) => table_name).join(', ')}); reconcile those rows before transfer`,
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

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function assertSevenDistinctEndpoints(
  endpoints: Record<Owner, { source: Endpoint; target: Endpoint }>,
  emailSource: Endpoint,
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
  const emailKey = `${emailSource.host}:${emailSource.port}/${emailSource.database}`;
  const previous = seen.get(emailKey);
  if (previous)
    throw new Error(
      `${previous} and legacy email source target the same PostgreSQL database`,
    );
}

async function inspectLedger(
  client: Client,
  owner: Owner,
): Promise<LedgerInspection> {
  const nestColumns = await client.query<{ column_name: string }>(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema='public'
       AND table_name='myota_nest_schema_migration'
  `);
  const nestNames = new Set(nestColumns.rows.map((row) => row.column_name));
  if (['owner', 'migration', 'checksum'].every((name) => nestNames.has(name))) {
    const result = await client.query<{ migration: string }>(
      'SELECT migration FROM public.myota_nest_schema_migration WHERE owner=$1 ORDER BY migration',
      [owner],
    );
    return { kind: 'nestjs', rows: result.rows } as const;
  }
  if (nestNames.size) return { kind: 'unknown', rows: [] as [] } as const;

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
  const legacyNestLedger = ['owner', 'migration', 'checksum'].every((name) =>
    names.has(name),
  );
  if (legacyNestLedger) {
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
