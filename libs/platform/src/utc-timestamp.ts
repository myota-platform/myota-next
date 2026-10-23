import type { PoolClient } from 'pg';

/** Return the database clock as a UTC ISO timestamp with microsecond precision. */
export async function utcTimestamp(client: PoolClient): Promise<string> {
  const result = await client.query<{ timestamp: string }>(
    `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS timestamp`,
  );
  return result.rows[0].timestamp;
}
