import { Client } from 'pg';

const owners = ['core', 'activity', 'geo'] as const;
type Owner = (typeof owners)[number];

const ownerConfig = {
  core: {
    url: 'CORE_DATABASE_URL',
    database: 'myota_core',
    role: 'myota_core_app',
  },
  activity: {
    url: 'ACTIVITY_DATABASE_URL',
    database: 'myota_activity',
    role: 'myota_activity_app',
  },
  geo: {
    url: 'GEO_DATABASE_URL',
    database: 'myota_geo',
    role: 'myota_geo_app',
  },
} satisfies Record<Owner, { url: string; database: string; role: string }>;

async function main(): Promise<void> {
  const urls = Object.fromEntries(
    owners.map((owner) => [
      owner,
      parseUrl(requiredEnv(ownerConfig[owner].url)),
    ]),
  ) as Record<Owner, URL>;

  for (const credentialOwner of owners) {
    for (const databaseOwner of owners) {
      const url = new URL(urls[databaseOwner]);
      url.username = decodeURIComponent(urls[credentialOwner].username);
      url.password = decodeURIComponent(urls[credentialOwner].password);
      const client = new Client({
        connectionString: url.toString(),
        connectionTimeoutMillis: 5000,
        application_name: `myota-db-isolation-${credentialOwner}-to-${databaseOwner}`,
      });

      if (credentialOwner !== databaseOwner) {
        try {
          await client.connect();
          await client.end();
          throw new Error(
            `${credentialOwner} runtime credential authenticated to ${databaseOwner}`,
          );
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.includes('runtime credential authenticated')
          )
            throw error;
          const code =
            typeof error === 'object' && error !== null && 'code' in error
              ? error.code
              : undefined;
          if (code !== '28P01' && code !== '28000' && code !== '42501')
            throw new Error(
              `Cross-owner access did not fail with an authentication or database permission denial: ${credentialOwner} -> ${databaseOwner}`,
              { cause: error },
            );
          await client.end().catch(() => undefined);
          process.stdout.write(
            `Cross-owner database access denied: ${credentialOwner} -> ${databaseOwner}\n`,
          );
        }
        continue;
      }

      await client.connect();
      try {
        const result = await client.query<{
          database: string;
          role: string;
          isSuperuser: boolean;
          canCreateRoles: boolean;
          canCreateDatabase: boolean;
          canReplicate: boolean;
          canBypassRls: boolean;
          canCreateSchema: boolean;
          applicationTable: string | null;
          canSelect: boolean | null;
          canInsert: boolean | null;
          canUpdate: boolean | null;
          canDelete: boolean | null;
        }>(
          `SELECT current_database() AS database,
                  current_user AS role,
                  r.rolsuper AS "isSuperuser",
                  r.rolcreaterole AS "canCreateRoles",
                  r.rolcreatedb AS "canCreateDatabase",
                  r.rolreplication AS "canReplicate",
                  r.rolbypassrls AS "canBypassRls",
                  has_schema_privilege(current_user, 'public', 'CREATE') AS "canCreateSchema",
                  app_table.oid::regclass::text AS "applicationTable",
                  has_table_privilege(current_user, app_table.oid, 'SELECT') AS "canSelect",
                  has_table_privilege(current_user, app_table.oid, 'INSERT') AS "canInsert",
                  has_table_privilege(current_user, app_table.oid, 'UPDATE') AS "canUpdate",
                  has_table_privilege(current_user, app_table.oid, 'DELETE') AS "canDelete"
             FROM pg_catalog.pg_roles AS r
             LEFT JOIN LATERAL (
               SELECT c.oid
                 FROM pg_catalog.pg_class AS c
                 JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public'
                  AND c.relkind IN ('r', 'p')
                  AND c.relname <> 'myota_nest_schema_migration'
                ORDER BY c.relname
                LIMIT 1
             ) AS app_table ON true
            WHERE r.rolname = current_user`,
        );
        const actual = result.rows[0];
        if (!actual)
          throw new Error(`No runtime role found for ${databaseOwner}`);
        if (actual.database !== ownerConfig[databaseOwner].database)
          throw new Error(
            `${databaseOwner} URL reached an unexpected database`,
          );
        if (actual.role !== ownerConfig[databaseOwner].role)
          throw new Error(
            `${databaseOwner} URL used an unexpected runtime role`,
          );
        if (
          actual.isSuperuser ||
          actual.canCreateRoles ||
          actual.canCreateDatabase ||
          actual.canReplicate ||
          actual.canBypassRls ||
          actual.canCreateSchema
        )
          throw new Error(
            `${databaseOwner} runtime role has administrative privileges`,
          );
        if (
          !actual.applicationTable ||
          !actual.canSelect ||
          !actual.canInsert ||
          !actual.canUpdate ||
          !actual.canDelete
        )
          throw new Error(
            `${databaseOwner} runtime role lacks required application-table privileges`,
          );
        process.stdout.write(
          `Owner access verified: ${databaseOwner} as ${actual.role}; no rows read\n`,
        );
      } finally {
        await client.end();
      }
    }
  }
}

function parseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch (error) {
    throw new Error('Runtime database URL is invalid', { cause: error });
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
