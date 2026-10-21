import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const owners = [
  ['core', 'CORE_DATABASE_URL'],
  ['activity', 'ACTIVITY_DATABASE_URL'],
  ['geo', 'GEO_DATABASE_URL'],
];
const probeTable = 'public.myota_backup_restore_probe';

if (process.env.MYOTA_BACKUP_RESTORE_TEST_ALLOW !== '1')
  throw new Error(
    'Set MYOTA_BACKUP_RESTORE_TEST_ALLOW=1 to run against disposable databases',
  );
for (const [, variable] of owners) {
  if (!process.env[variable]) throw new Error(`${variable} is required`);
}

const pools = () =>
  owners.map(
    ([, variable]) =>
      new pg.Pool({
        connectionString: process.env[variable],
      }),
  );

async function run(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
  });
}

const directory = await mkdtemp(join(tmpdir(), 'myota-backup-restore-'));
try {
  for (const pool of pools()) {
    try {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS ${probeTable} (id integer PRIMARY KEY, value text NOT NULL)`,
      );
      await pool.query(
        `INSERT INTO ${probeTable} (id, value) VALUES (1, 'snapshot')
         ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`,
      );
    } finally {
      await pool.end();
    }
  }

  const backup = await run([
    '--experimental-strip-types',
    'tools/db-backup.ts',
    directory,
  ]);
  if (backup.code !== 0)
    throw new Error(`database backup failed: ${backup.stderr}`);
  const backupPath = backup.stdout.trim().split('\n').at(-1);
  if (!backupPath) throw new Error('database backup did not report its path');

  for (const pool of pools()) {
    try {
      await pool.query(
        `UPDATE ${probeTable} SET value = 'mutated' WHERE id = 1`,
      );
    } finally {
      await pool.end();
    }
  }

  const confirmation = `RESTORE ${backupPath.split('/').at(-1)}`;
  const rejected = await run(
    ['--experimental-strip-types', 'tools/db-restore.ts', backupPath],
    { ...process.env, MYOTA_RESTORE_CONFIRM: 'RESTORE wrong-directory' },
  );
  if (
    rejected.code === 0 ||
    !rejected.stderr.includes(
      `Set MYOTA_RESTORE_CONFIRM to exactly: ${confirmation}`,
    )
  )
    throw new Error('restore did not enforce its exact confirmation value');

  const restored = await run(
    ['--experimental-strip-types', 'tools/db-restore.ts', backupPath],
    { ...process.env, MYOTA_RESTORE_CONFIRM: confirmation },
  );
  if (restored.code !== 0)
    throw new Error(`database restore failed: ${restored.stderr}`);

  for (const [index, pool] of pools().entries()) {
    try {
      const result = await pool.query(
        `SELECT value FROM ${probeTable} WHERE id = 1`,
      );
      if (result.rows[0]?.value !== 'snapshot')
        throw new Error(
          `${owners[index][0]} restore did not recover the snapshot`,
        );
    } finally {
      await pool.end();
    }
  }

  process.stdout.write(
    'Backup and restore verified for Core, Activity, and Geodata\n',
  );
} finally {
  for (const pool of pools()) {
    try {
      await pool.query(`DROP TABLE IF EXISTS ${probeTable}`);
    } finally {
      await pool.end();
    }
  }
  await rm(directory, { recursive: true, force: true });
}
