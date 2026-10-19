import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';

const allowedErrors = new Set(['recipient_unavailable', 'delivery_exhausted']);
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function main(args: string[]) {
  const options = parseArgs(args);
  if (
    !uuid.test(options.workId) ||
    !allowedErrors.has(options.errorCode) ||
    !/^[A-Za-z0-9@._:-]{1,120}$/.test(options.actor) ||
    options.reason.trim().length < 12 ||
    options.reason.trim().length > 500
  ) {
    throw new Error('invalid redrive arguments');
  }
  const connectionString = await databaseUrl();
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const reset = await client.query(
      `UPDATE public.email_delivery
          SET status='PENDING',lease_until=NULL,last_error_code=NULL,updated_at=now()
        WHERE work_id=$1 AND status='DEAD_LETTER'
        RETURNING work_id`,
      [options.workId.toLowerCase()],
    );
    if (!reset.rows[0]) {
      await client.query('ROLLBACK');
      process.stderr.write('No matching dead-letter delivery was found.\n');
      process.exitCode = 2;
      return;
    }
    await client.query(
      `INSERT INTO public.email_dead_letter_redrive
       (work_id,error_code,actor,reason,requested_at)
       VALUES ($1,$2,$3,$4,now())`,
      [
        options.workId.toLowerCase(),
        options.errorCode,
        options.actor,
        options.reason.trim(),
      ],
    );
    const audited = await client.query(
      `UPDATE public.email_dead_letter
          SET redrive_requested_at=now(),redrive_actor=$3,redrive_reason=$4
        WHERE work_id=$1 AND error_code=$2 AND resolved_at IS NULL
        RETURNING id`,
      [
        options.workId.toLowerCase(),
        options.errorCode,
        options.actor,
        options.reason.trim(),
      ],
    );
    if (!audited.rows[0])
      throw new Error('matching unresolved dead-letter record was not found');
    await client.query('COMMIT');
    process.stdout.write(
      `Audited redrive recorded for ${options.workId}; replay its original command through the producer outbox.\n`,
    );
  } catch (error) {
    await client?.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}

function parseArgs(args: string[]) {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !key?.startsWith('--') ||
      !value ||
      key in result ||
      !['work-id', 'error-code', 'actor', 'reason'].includes(key.slice(2))
    )
      throw new Error(
        'usage: --work-id UUID --error-code recipient_unavailable|delivery_exhausted --actor ID --reason TEXT',
      );
    result[key.slice(2)] = value;
  }
  const { 'work-id': workId, 'error-code': errorCode, actor, reason } = result;
  if (!workId || !errorCode || !actor || !reason)
    throw new Error(
      'usage: --work-id UUID --error-code recipient_unavailable|delivery_exhausted --actor ID --reason TEXT',
    );
  return { workId, errorCode, actor, reason };
}

async function databaseUrl() {
  const value = process.env.CORE_DATABASE_URL ?? '';
  const path = process.env.CORE_DATABASE_URL_FILE;
  if (value && path)
    throw new Error(
      'CORE_DATABASE_URL and CORE_DATABASE_URL_FILE are exclusive',
    );
  if (value) return value;
  if (path) return (await readFile(path, 'utf8')).replace(/[\r\n]+$/, '');
  throw new Error('CORE_DATABASE_URL is required');
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'redrive failed'}\n`,
  );
  process.exitCode = 1;
}
