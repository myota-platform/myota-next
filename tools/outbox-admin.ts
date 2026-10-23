import { Pool, type PoolClient } from 'pg';

type DeadLetter = {
  event_id: string;
  event_type: string;
  attempts: number;
  error: string | null;
  dead_lettered_at: Date;
  resolved_at: Date | null;
};

function connectionString(): string {
  const value = process.env.OUTBOX_DATABASE_URL ?? '';
  if (!value) throw new Error('OUTBOX_DATABASE_URL is required');
  return value;
}

async function listDeadLetters(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error('limit must be between 1 and 1000');

  const pool = new Pool({
    connectionString: connectionString(),
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  try {
    const result = await pool.query<DeadLetter>(
      `SELECT event_id, event_type, attempts, error, dead_lettered_at,
              resolved_at
         FROM public.dead_letter_event
        ORDER BY dead_lettered_at DESC, event_id
        LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      eventId: row.event_id,
      eventType: row.event_type,
      attempts: row.attempts,
      error: (row.error ?? '').slice(0, 500),
      deadLetteredAt: row.dead_lettered_at.toISOString(),
      resolvedAt: row.resolved_at?.toISOString() ?? null,
    }));
  } finally {
    await pool.end();
  }
}

async function redrive(eventId: string, actor: string, reason: string) {
  const normalizedId = normalizeUuid(eventId);
  const normalizedActor = actor.trim();
  const normalizedReason = reason.trim();
  if (!normalizedActor || normalizedActor.length > 120)
    throw new Error('actor must contain 1 to 120 characters');
  if (!normalizedReason || normalizedReason.length > 500)
    throw new Error('reason must contain 1 to 500 characters');

  const pool = new Pool({
    connectionString: connectionString(),
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const result = await client.query<{
      event_type: string;
      attempts: number | null;
      error: string | null;
      published_at: Date | null;
    }>(
      `SELECT e.event_type, e.attempts, d.error, e.published_at
         FROM public.outbox_event AS e
         JOIN public.dead_letter_event AS d USING (event_id)
        WHERE e.event_id = $1 AND d.resolved_at IS NULL
        FOR UPDATE OF e, d`,
      [normalizedId],
    );
    const event = result.rows[0];
    if (!event)
      throw new Error(
        'no unresolved dead letter with a retained outbox row was found',
      );
    if (event.attempts === null || event.published_at === null)
      throw new Error(
        'dead-letter source outbox row is not in a completed state',
      );

    await client.query(
      `INSERT INTO public.outbox_redrive_audit
         (event_id, actor, reason, previous_attempts, previous_error)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        normalizedId,
        normalizedActor,
        normalizedReason,
        event.attempts,
        event.error,
      ],
    );
    await client.query(
      `UPDATE public.outbox_event
          SET published_at = NULL, available_at = now(), attempts = 0,
              last_error = NULL
        WHERE event_id = $1`,
      [normalizedId],
    );
    await client.query('COMMIT');
    return {
      eventId: normalizedId,
      eventType: event.event_type,
      actor: normalizedActor,
    };
  } catch (error) {
    await client?.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}

function normalizeUuid(value: string): string {
  let hex = value.toLowerCase();
  if (hex.startsWith('urn:uuid:')) hex = hex.slice('urn:uuid:'.length);
  if (hex.startsWith('{') && hex.endsWith('}')) hex = hex.slice(1, -1);
  hex = hex.replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error('event-id must be a UUID');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseArgs(values: string[]) {
  const [command, ...args] = values;
  if (command === 'list') {
    let limit = 100;
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] !== '--limit' || !args[index + 1])
        throw new Error('usage: outbox:admin list [--limit 1..1000]');
      limit = Number(args[++index]);
    }
    return { command, limit } as const;
  }
  if (command === 'redrive') {
    const [eventId, ...options] = args;
    const parsed: Record<string, string> = {};
    for (let index = 0; index < options.length; index += 2) {
      const key = options[index];
      const value = options[index + 1];
      if (
        !['--actor', '--reason'].includes(key) ||
        !value ||
        value.startsWith('--') ||
        key in parsed
      )
        throw new Error(
          'usage: outbox:admin redrive UUID --actor ID --reason TEXT',
        );
      parsed[key] = value;
    }
    if (!eventId || !parsed['--actor'] || !parsed['--reason'])
      throw new Error(
        'usage: outbox:admin redrive UUID --actor ID --reason TEXT',
      );
    return {
      command,
      eventId,
      actor: parsed['--actor'],
      reason: parsed['--reason'],
    } as const;
  }
  throw new Error(
    'usage: outbox:admin list [--limit 1..1000] | outbox:admin redrive UUID --actor ID --reason TEXT',
  );
}

try {
  const options = parseArgs(process.argv.slice(2));
  const result =
    options.command === 'list'
      ? await listDeadLetters(options.limit)
      : await redrive(options.eventId, options.actor, options.reason);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `outbox admin failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exitCode = 1;
}
