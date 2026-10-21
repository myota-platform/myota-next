import { createHash, randomBytes } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from 'pg';

const execFile = promisify(execFileCallback);
const baseUrl = process.env.GEO_PARITY_DATABASE_URL;
if (!baseUrl) throw new Error('GEO_PARITY_DATABASE_URL is required');
const parsedBaseUrl = new URL(baseUrl);
if (
  !['localhost', '127.0.0.1', '[::1]', 'geo-db'].includes(
    parsedBaseUrl.hostname,
  )
)
  throw new Error(
    'GEO_PARITY_DATABASE_URL must point to a local test database',
  );

const suffix = randomBytes(5).toString('hex');
const names = Object.fromEntries(
  [
    'core-source',
    'activity-source',
    'geo-source',
    'email-source',
    'core-target',
    'activity-target',
    'geo-target',
  ].map((name) => [name, `mtf_${suffix}_${name.replace('-', '_')}`]),
);
const endpoints = Object.fromEntries(
  Object.entries(names).map(([key, database]) => {
    const url = new URL(baseUrl);
    url.pathname = `/${database}`;
    return [key, url.toString()];
  }),
);
const admin = new Client({ connectionString: baseUrl });
const created = [];
const createdRoles = [];
const geodataAclRoles = ['myota_geo_qgis_editor', 'myota_geo_qgis_readonly'];
const workId = '00000000-0000-4000-8000-000000000001';
const archiveParent = await mkdtemp(join(tmpdir(), 'myota-transfer-workflow-'));
const archive = join(archiveParent, 'archive');

function endpointLabel(url) {
  const value = new URL(url);
  return `${value.hostname}:${value.port || '5432'}${decodeURIComponent(value.pathname)}`;
}

async function run(args, env) {
  let result;
  try {
    result = await execFile(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    if (args.includes('tools/db-transfer-validate.ts')) {
      const output = error && typeof error === 'object' ? error.stdout : null;
      if (typeof output === 'string') {
        try {
          const report = JSON.parse(output);
          const failures = Object.entries(report.owners ?? {}).flatMap(
            ([owner, data]) =>
              (data.checks ?? [])
                .filter((check) => check.status === 'failed')
                .map(
                  (check) =>
                    `${owner}/${check.name}: ${check.detail ?? 'check failed'}; source=${JSON.stringify(check.source)}; target=${JSON.stringify(check.target)}`,
                ),
          );
          if (failures.length)
            throw new Error(
              `Transfer validation checks failed: ${failures.join('; ')}`,
              { cause: error },
            );
        } catch (parseError) {
          if (
            parseError instanceof Error &&
            parseError.message.startsWith('Transfer validation checks failed:')
          )
            throw parseError;
        }
      }
    }
    throw error;
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.stdout;
}

async function applySql(url, sql) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function query(url, sql, values = [], setupSql) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    if (setupSql) await client.query(setupSql);
    return await client.query(sql, values);
  } finally {
    await client.end();
  }
}

async function createSource(key, migrations, beforeMigration) {
  const database = names[key];
  const exists = await admin.query(
    'SELECT 1 FROM pg_database WHERE datname=$1',
    [database],
  );
  if (exists.rowCount)
    throw new Error(`Refusing to reuse database ${database}`);
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
  created.push(database);
  for (const [index, migration] of migrations.entries()) {
    if (index === 2 && beforeMigration) await beforeMigration(endpoints[key]);
    const sql = await readFile(migration.path, 'utf8');
    await applySql(endpoints[key], sql);
    if (migration.ledger) {
      await query(
        endpoints[key],
        `INSERT INTO public.myota_schema_migration (migration_id,checksum,application_mode)
         VALUES ($1,$2,'applied')
         ON CONFLICT (migration_id) DO UPDATE SET checksum=EXCLUDED.checksum,application_mode='applied'`,
        [migration.ledger, migration.checksum(sql)],
      );
    } else if (index === 0) {
      await query(
        endpoints[key],
        `UPDATE public.myota_schema_migration SET checksum=$1,application_mode='applied'
          WHERE migration_id='baseline-v1'`,
        [migration.checksum(sql)],
      );
    }
  }
}

try {
  await admin.connect();
  const sha256 = (sql) => createHash('sha256').update(sql).digest('hex');
  await createSource(
    'core-source',
    [
      {
        path: 'deploy/db/migrations/core/001_core_baseline.sql',
        checksum: sha256,
      },
      {
        path: 'deploy/db/migrations/core/002_identity_auth_support.sql',
        ledger: '002_identity_auth_support.sql',
        checksum: sha256,
      },
      {
        path: 'deploy/db/migrations/core/003_identity_auth_backfill.sql',
        ledger: '003_identity_auth_backfill.sql',
        checksum: sha256,
      },
    ],
    async (url) => {
      const accountId = '00000000-0000-4000-8000-000000000002';
      const timestamp = '2026-01-02T03:04:05.000Z';
      await query(
        url,
        `INSERT INTO public.service_state (service,state,updated_at)
       VALUES ('identity',$1::jsonb,$2::timestamptz)`,
        [
          JSON.stringify({
            items: {
              [accountId]: {
                id: accountId,
                displayName: 'Transfer Fixture',
                email: 'Transfer.Fixture@example.test',
                participationType: 'OPERATOR',
                status: 'ACTIVE',
                createdAt: timestamp,
                updatedAt: timestamp,
              },
            },
            data: {},
          }),
          timestamp,
        ],
      );
    },
  );
  await createSource('activity-source', [
    {
      path: 'deploy/db/migrations/activity/001_activity_baseline.sql',
      checksum: sha256,
    },
  ]);
  await query(
    endpoints['activity-source'],
    `INSERT INTO public.activity_job (id,kind,payload,status,attempts)
     VALUES ('00000000-0000-4000-8000-000000000003','transfer-fixture','{"fixture":true}'::jsonb,'QUEUED',0)`,
  );
  for (const role of geodataAclRoles) {
    const result = await admin.query(
      'SELECT 1 FROM pg_roles WHERE rolname=$1',
      [role],
    );
    if (!result.rowCount) createdRoles.push(role);
  }
  await createSource('geo-source', [
    {
      path: 'deploy/db/migrations/geo/001_geodata_baseline.sql',
      checksum: sha256,
    },
  ]);
  await query(
    endpoints['geo-source'],
    `INSERT INTO public.geodata_entity (id,name,geom)
     VALUES ('00000000-0000-4000-8000-000000000004','Transfer Fixture',
             ST_SetSRID(ST_Point(13.405,52.52),4326))`,
    [],
    `SELECT set_config('myota.geodata_writer','row-v1',false)`,
  );

  const emailName = names['email-source'];
  const emailExists = await admin.query(
    'SELECT 1 FROM pg_database WHERE datname=$1',
    [emailName],
  );
  if (emailExists.rowCount)
    throw new Error(`Refusing to reuse database ${emailName}`);
  await admin.query(`CREATE DATABASE "${emailName}" TEMPLATE template0`);
  created.push(emailName);
  await applySql(
    endpoints['email-source'],
    await readFile(
      'docs/reference/migrations/app-migrations/email/001_email_delivery.sql',
      'utf8',
    ),
  );
  await query(
    endpoints['email-source'],
    `INSERT INTO public.email_delivery
       (work_id,template_id,status,attempts,last_error_code,received_at,created_at,updated_at)
     VALUES ($1,'transfer-fixture','DEAD_LETTER',1,'delivery_exhausted',now(),now(),now())`,
    [workId],
  );
  await query(
    endpoints['email-source'],
    `INSERT INTO public.email_delivery_attempt (work_id,outcome,error_code)
     VALUES ($1,'dead_letter','delivery_exhausted')`,
    [workId],
  );
  await query(
    endpoints['email-source'],
    `INSERT INTO public.email_dead_letter (work_id,error_code) VALUES ($1,'delivery_exhausted')`,
    [workId],
  );
  await query(
    endpoints['email-source'],
    `INSERT INTO public.email_dead_letter_redrive (work_id,error_code,actor,reason)
     VALUES ($1,'delivery_exhausted','transfer-workflow-check','Disposable transfer workflow fixture')`,
    [workId],
  );

  for (const key of ['core-target', 'activity-target', 'geo-target']) {
    const database = names[key];
    const exists = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname=$1',
      [database],
    );
    if (exists.rowCount)
      throw new Error(`Refusing to reuse database ${database}`);
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
    created.push(database);
  }
  await query(
    endpoints['geo-target'],
    `GRANT USAGE ON SCHEMA public TO ${['myota', ...geodataAclRoles].map((role) => `"${role}"`).join(', ')}`,
  );

  const env = {
    LEGACY_CORE_DATABASE_URL: endpoints['core-source'],
    LEGACY_ACTIVITY_DATABASE_URL: endpoints['activity-source'],
    LEGACY_GEO_DATABASE_URL: endpoints['geo-source'],
    LEGACY_EMAIL_DATABASE_URL: endpoints['email-source'],
    CORE_DATABASE_URL: endpoints['core-target'],
    ACTIVITY_DATABASE_URL: endpoints['activity-target'],
    GEO_DATABASE_URL: endpoints['geo-target'],
    MYOTA_TRANSFER_SOURCE_FROZEN: 'YES',
  };
  const transferConfirmation = `TRANSFER core=${endpointLabel(env.CORE_DATABASE_URL)} activity=${endpointLabel(env.ACTIVITY_DATABASE_URL)} geo=${endpointLabel(env.GEO_DATABASE_URL)}`;
  const validationConfirmation = `VALIDATE core=${endpointLabel(env.CORE_DATABASE_URL)} activity=${endpointLabel(env.ACTIVITY_DATABASE_URL)} geo=${endpointLabel(env.GEO_DATABASE_URL)}`;

  await run(
    [
      '--experimental-strip-types',
      'tools/db-transfer-stage.ts',
      `--archive-dir=${archive}`,
    ],
    env,
  );
  await run(
    [
      '--experimental-strip-types',
      'tools/db-transfer-apply.ts',
      `--archive-dir=${archive}`,
    ],
    {
      ...env,
      MYOTA_TRANSFER_TARGET_OFFLINE: 'YES',
      MYOTA_TRANSFER_CONFIRM: transferConfirmation,
    },
  );
  await run(
    [
      '--experimental-strip-types',
      'tools/db-transfer-validate.ts',
      `--archive-dir=${archive}`,
    ],
    {
      ...env,
      MYOTA_TRANSFER_TARGET_OFFLINE: 'YES',
      MYOTA_TRANSFER_VALIDATION_CONFIRM: validationConfirmation,
    },
  );

  const report = await readdir(archive);
  if (
    !report.some(
      (file) => file.startsWith('validation-report-') && file.endsWith('.json'),
    )
  )
    throw new Error('Transfer validation report was not created');
  const merged = await query(
    endpoints['core-target'],
    `SELECT
       (SELECT count(*)::integer FROM public.email_delivery WHERE work_id=$1) AS deliveries,
       (SELECT count(*)::integer FROM public.email_delivery_attempt WHERE work_id=$1) AS attempts,
       (SELECT count(*)::integer FROM public.email_dead_letter WHERE work_id=$1) AS dead_letters,
       (SELECT count(*)::integer FROM public.email_dead_letter_redrive WHERE work_id=$1) AS redrives`,
    [workId],
  );
  const counts = Object.values(merged.rows[0] ?? {});
  if (counts.length !== 4 || counts.some((count) => count !== 1))
    throw new Error(
      `Legacy Email rows were not merged into Core: ${JSON.stringify(merged.rows[0])}`,
    );
  const [coreFixture, activityFixture, geoFixture] = await Promise.all([
    query(
      endpoints['core-target'],
      `SELECT id,email::text AS email FROM public.account
        WHERE id='00000000-0000-4000-8000-000000000002'`,
    ),
    query(
      endpoints['activity-target'],
      `SELECT id FROM public.activity_job
        WHERE id='00000000-0000-4000-8000-000000000003'`,
    ),
    query(
      endpoints['geo-target'],
      `SELECT id,name FROM public.geodata_entity
        WHERE id='00000000-0000-4000-8000-000000000004'`,
    ),
  ]);
  if (
    coreFixture.rows[0]?.email !== 'transfer.fixture@example.test' ||
    activityFixture.rowCount !== 1 ||
    geoFixture.rows[0]?.name !== 'Transfer Fixture'
  )
    throw new Error('Owner database fixture data did not survive the transfer');
  process.stdout.write(
    'Full disposable four-source to three-target transfer workflow verified.\n',
  );
} finally {
  for (const database of created.reverse())
    await admin
      .query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
      .catch(() => undefined);
  for (const role of createdRoles)
    await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
  await admin.end().catch(() => undefined);
  await rm(archiveParent, { recursive: true, force: true });
}
