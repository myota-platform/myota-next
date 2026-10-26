import { Client } from 'pg';

const owners = {
  core: {
    url: 'CORE_DATABASE_URL',
    password: 'CORE_RUNTIME_DB_PASSWORD',
    role: 'myota_core_app',
  },
  activity: {
    url: 'ACTIVITY_DATABASE_URL',
    password: 'ACTIVITY_RUNTIME_DB_PASSWORD',
    role: 'myota_activity_app',
  },
  geo: {
    url: 'GEO_DATABASE_URL',
    password: 'GEO_RUNTIME_DB_PASSWORD',
    role: 'myota_geo_app',
  },
} as const;

type Owner = keyof typeof owners;

async function main(): Promise<void> {
  const retireLegacy = parseArgs(process.argv.slice(2));
  for (const owner of Object.keys(owners) as Owner[]) {
    await syncOwner(owner, owners[owner]);
    process.stdout.write(`Runtime database role synchronized for ${owner}\n`);
    if (retireLegacy) {
      await retireLegacyRole(owner, owners[owner]);
      process.stdout.write(`Legacy runtime role retired for ${owner}\n`);
    }
  }
}

async function syncOwner(
  owner: Owner,
  config: (typeof owners)[Owner],
): Promise<void> {
  const url = requiredEnv(config.url);
  const password = requiredEnv(config.password);
  if (password.length < 32)
    throw new Error(`${config.password} must contain at least 32 characters`);

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const identity = await client.query<{
      database: string;
      currentUser: string;
      canManageRoles: boolean;
    }>(
      `SELECT current_database() AS database,
              current_user AS "currentUser",
              (r.rolsuper OR r.rolcreaterole) AS "canManageRoles"
         FROM pg_catalog.pg_roles AS r
        WHERE r.rolname = current_user`,
    );
    const admin = identity.rows[0];
    if (!admin?.canManageRoles)
      throw new Error(`${config.url} must use a migration/admin role`);
    if (admin.currentUser === config.role || admin.currentUser === 'myota_app')
      throw new Error(`${config.url} must not use a runtime role`);

    const membership = await client.query(
      `SELECT 1
         FROM pg_catalog.pg_auth_members
        WHERE member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
        LIMIT 1`,
      [config.role],
    );
    if (membership.rowCount)
      throw new Error(`${config.role} has unexpected role memberships`);

    const exists = await client.query(
      'SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1',
      [config.role],
    );
    const roleStatement = await client.query<{ sql: string }>(
      `SELECT format(
         CASE WHEN $3::boolean THEN
           'ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT'
         ELSE
           'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT'
         END,
         $1::text, $2::text) AS sql`,
      [config.role, password, exists.rowCount === 1],
    );
    await client.query(roleStatement.rows[0]!.sql);

    await executeFormatted(
      client,
      'REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I',
      [admin.database, config.role],
    );
    await executeFormatted(
      client,
      'REVOKE CONNECT ON DATABASE %I FROM PUBLIC',
      [admin.database],
    );
    await executeFormatted(client, 'GRANT CONNECT ON DATABASE %I TO %I', [
      admin.database,
      config.role,
    ]);
    await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await executeFormatted(client, 'REVOKE CREATE ON SCHEMA public FROM %I', [
      config.role,
    ]);
    await executeFormatted(client, 'GRANT USAGE ON SCHEMA public TO %I', [
      config.role,
    ]);
    await executeFormatted(
      client,
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I',
      [config.role],
    );
    await executeFormatted(
      client,
      'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO %I',
      [config.role],
    );

    const defaults = await client.query<{ sql: string }>(
      `SELECT format(
         'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
         current_user, $1::text) AS sql`,
      [config.role],
    );
    await client.query(defaults.rows[0]!.sql);
    const sequenceDefaults = await client.query<{ sql: string }>(
      `SELECT format(
         'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I',
         current_user, $1::text) AS sql`,
      [config.role],
    );
    await client.query(sequenceDefaults.rows[0]!.sql);

    const migrationLedger = await client.query<{ exists: boolean }>(
      `SELECT to_regclass('public.myota_nest_schema_migration') IS NOT NULL AS exists`,
    );
    if (migrationLedger.rows[0]?.exists)
      await client.query(
        `REVOKE ALL ON TABLE public.myota_nest_schema_migration FROM ${config.role}`,
      );
  } finally {
    await client.end();
  }
}

async function retireLegacyRole(
  owner: Owner,
  config: (typeof owners)[Owner],
): Promise<void> {
  const client = new Client({ connectionString: requiredEnv(config.url) });
  await client.connect();
  try {
    const identity = await client.query<{ currentUser: string }>(
      'SELECT current_user AS "currentUser"',
    );
    const currentUser = identity.rows[0]?.currentUser;
    if (currentUser === 'myota_app')
      throw new Error(`${config.url} must not use the legacy runtime role`);
    const exists = await client.query(
      `SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'myota_app'`,
    );
    if (!exists.rowCount) return;

    await client.query(
      'ALTER ROLE myota_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT',
    );
    await executeFormatted(
      client,
      'REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I',
      [
        (
          await client.query<{ database: string }>(
            'SELECT current_database() AS database',
          )
        ).rows[0]!.database,
        'myota_app',
      ],
    );
    await client.query('REVOKE ALL ON SCHEMA public FROM myota_app');
    await client.query(
      'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM myota_app',
    );
    await client.query(
      'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM myota_app',
    );
    await executeFormatted(
      client,
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM %I',
      [currentUser!, 'myota_app'],
    );
    await executeFormatted(
      client,
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I',
      [currentUser!, 'myota_app'],
    );
    await client.query(
      `SELECT pg_catalog.pg_terminate_backend(pid)
         FROM pg_catalog.pg_stat_activity
        WHERE usename = 'myota_app' AND pid <> pg_backend_pid()`,
    );
  } finally {
    await client.end();
  }
  process.stdout.write(
    `Legacy role disabled and sessions stopped for ${owner}\n`,
  );
}

async function executeFormatted(
  client: Client,
  statement: string,
  values: string[],
): Promise<void> {
  const formatArguments = values
    .map((_, index) => `$${index + 2}::text`)
    .join(', ');
  const formatted = await client.query<{ sql: string }>(
    `SELECT format($1::text, ${formatArguments}) AS sql`,
    [statement, ...values],
  );
  await client.query(formatted.rows[0]!.sql);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseArgs(args: string[]): boolean {
  if (args.length === 0) return false;
  if (args.length === 1 && args[0] === '--retire-legacy') return true;
  throw new Error(
    'Usage: node tools/sync-database-runtime-roles.ts [--retire-legacy]',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
