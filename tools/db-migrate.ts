import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const ownerUrls = {
  core: 'CORE_DATABASE_URL',
  activity: 'ACTIVITY_DATABASE_URL',
  geo: 'GEO_DATABASE_URL',
} as const;
type Owner = keyof typeof ownerUrls;

async function main(): Promise<void> {
  const owner = parseOwner(process.argv.slice(2));
  const url = process.env[ownerUrls[owner]];
  if (!url) throw new Error(`${ownerUrls[owner]} is required`);

  const directory = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'deploy',
    'db',
    'migrations',
    owner,
  );
  const files = (await readdir(directory))
    .filter((file) => file.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right));
  if (!files.length) throw new Error(`No SQL migrations found for ${owner}`);

  const client = new Client({
    connectionString: url,
    application_name: `myota-db-migrate-${owner}`,
  });
  await client.connect();
  const lockKey = `myota:migrations:${owner}`;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
      lockKey,
    ]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS public.myota_nest_schema_migration (
        owner text NOT NULL,
        migration text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (owner,migration)
      )`,
    );
    for (const [index, file] of files.entries()) {
      if (!/^\d{3}_[a-z0-9_]+\.sql$/.test(file))
        throw new Error(`Invalid migration filename: ${file}`);
      const migration = index === 0 ? 'baseline-v1' : file;
      const sql = await readFile(join(directory, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const recorded = await client.query(
        'SELECT checksum FROM public.myota_nest_schema_migration WHERE owner=$1 AND migration=$2',
        [owner, migration],
      );
      if (recorded.rows[0]) {
        if (recorded.rows[0].checksum !== checksum)
          throw new Error(
            `Applied migration checksum changed: ${owner}/${migration}`,
          );
        continue;
      }

      // Baseline dumps set an empty session search_path. Restore the normal
      // application schema before applying each forward migration.
      await client.query(
        "SELECT pg_catalog.set_config('search_path', 'public', false)",
      );
      process.stdout.write(`Applying ${owner}/${file}\n`);
      await client.query('BEGIN');
      try {
        // pg's simple-query protocol accepts the multi-statement SQL dumps used
        // by the baseline files, including CREATE FUNCTION and DO blocks.
        await client.query(sql);
        await client.query(
          'INSERT INTO public.myota_nest_schema_migration(owner,migration,checksum) VALUES ($1,$2,$3)',
          [owner, migration, checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration failed: ${owner}/${file}`, { cause: error });
      }
    }
    process.stdout.write(`Migrations current for ${owner}\n`);
  } finally {
    await client
      .query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lockKey])
      .catch(() => undefined);
    await client.end();
  }
}

function parseOwner(args: string[]): Owner {
  if (args.length !== 1 || !args[0].startsWith('--owner='))
    throw new Error('Usage: npm run migrate:db -- --owner=core|activity|geo');
  const owner = args[0].slice('--owner='.length);
  if (owner !== 'core' && owner !== 'activity' && owner !== 'geo')
    throw new Error('Migration owner must be core, activity, or geo');
  return owner;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
