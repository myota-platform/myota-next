import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { Client } from 'pg';

const execFile = promisify(execFileCallback);
const baseUrl = process.env.GEO_PARITY_DATABASE_URL;
if (!baseUrl) {
  throw new Error('GEO_PARITY_DATABASE_URL is required for this check');
}
const parsedBaseUrl = new URL(baseUrl);
if (
  !['localhost', '127.0.0.1', '[::1]', 'geo-db'].includes(
    parsedBaseUrl.hostname,
  )
) {
  throw new Error(
    'GEO_PARITY_DATABASE_URL must point to a local test database',
  );
}

const owners = {
  core: {
    database: 'myota_core_transfer',
    migrations: [
      '001_core_baseline.sql',
      '002_identity_auth_support.sql',
      '003_identity_auth_backfill.sql',
    ],
  },
  activity: {
    database: 'myota_activity_transfer',
    migrations: ['001_activity_baseline.sql'],
  },
  geo: {
    database: 'myota_geo_transfer',
    migrations: ['001_geodata_baseline.sql'],
  },
};

const admin = new Client({ connectionString: baseUrl });
const created = [];
await admin.connect();
try {
  for (const [owner, config] of Object.entries(owners)) {
    const existing = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname=$1',
      [config.database],
    );
    if (existing.rowCount)
      throw new Error(`Refusing to reuse existing database ${config.database}`);
    await admin.query(
      `CREATE DATABASE "${config.database}" TEMPLATE template0`,
    );
    created.push(config.database);
    const databaseUrl = new URL(baseUrl);
    databaseUrl.pathname = `/${config.database}`;

    const target = new Client({ connectionString: databaseUrl.toString() });
    await target.connect();
    try {
      for (const [index, migration] of config.migrations.entries()) {
        const sql = await readFile(
          `deploy/db/migrations/${owner}/${migration}`,
          'utf8',
        );
        await target.query(
          "SELECT pg_catalog.set_config('search_path', 'public', false)",
        );
        await target.query(sql);
        const migrationId = index === 0 ? 'baseline-v1' : migration;
        const checksum = createHash('sha256').update(sql).digest('hex');
        await target.query(
          `INSERT INTO public.myota_schema_migration
             (migration_id, checksum, application_mode)
           VALUES ($1, $2, 'applied')
           ON CONFLICT (migration_id) DO UPDATE
             SET checksum=EXCLUDED.checksum, application_mode='applied'`,
          [migrationId, checksum],
        );
      }
    } finally {
      await target.end();
    }

    const ownerVariable = `${owner.toUpperCase()}_DATABASE_URL`;
    const env = {
      ...process.env,
      [ownerVariable]: databaseUrl.toString(),
      MYOTA_TRANSFER_LEDGER_CONFIRM: `ADOPT PYTHON LEDGER ${owner}=${databaseUrl.hostname}:${databaseUrl.port || '5432'}/${config.database}`,
    };
    for (const tool of ['db-transfer-adopt-ledger.ts', 'db-migrate.ts']) {
      const args = [
        '--experimental-strip-types',
        `tools/${tool}`,
        `--owner=${owner}`,
      ];
      const result = await execFile(process.execPath, args, { env });
      if (result.stdout) process.stdout.write(result.stdout);
    }

    const verify = new Client({ connectionString: databaseUrl.toString() });
    await verify.connect();
    try {
      const ledger = await verify.query(
        `SELECT migration FROM public.myota_nest_schema_migration
          WHERE owner=$1 ORDER BY migration`,
        [owner],
      );
      if (!ledger.rows.some((row) => row.migration === config.migrations[0]))
        throw new Error(
          `${owner} transfer did not retain the baseline ledger entry`,
        );
      const source = await verify.query(
        'SELECT count(*)::integer AS count FROM public.myota_schema_migration',
      );
      if (source.rows[0]?.count !== config.migrations.length)
        throw new Error(`${owner} Python migration ledger was not preserved`);
    } finally {
      await verify.end();
    }
  }
  process.stdout.write(
    'Python-ledger adoption and forward migrations verified for Core, Activity, and Geodata.\n',
  );
} finally {
  for (const database of created.reverse())
    await admin.query(`DROP DATABASE "${database}"`).catch(() => undefined);
  await admin.end();
}
