import { ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';

export type RequestReplay = {
  found: boolean;
  response: unknown;
};

export async function replayRequest(
  connect: () => Promise<PoolClient>,
  service: string,
  key: string,
  requestHash: string,
): Promise<RequestReplay> {
  const client = await connect();
  try {
    await client.query('BEGIN');
    await lockRequest(client, key);
    const replay = await readRequestResponse(client, service, key, requestHash);
    await client.query('COMMIT');
    return replay;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function lockRequest(client: PoolClient, key: string) {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('geodata:request:' || $1,0))",
    [key],
  );
}

export async function readRequestResponse(
  client: PoolClient,
  service: string,
  key: string,
  requestHash?: string,
): Promise<RequestReplay> {
  const result = await client.query(
    'SELECT response FROM idempotency_record WHERE service=$1 AND key=$2',
    [service, key],
  );
  if (!result.rows[0]) return { found: false, response: undefined };
  const saved: unknown = result.rows[0].response;
  if (requestHash) {
    if (
      !isRecord(saved) ||
      saved.requestHash !== requestHash ||
      !Object.hasOwn(saved, 'result')
    )
      throw new ConflictException(
        'Idempotency-Key was already used for another request',
      );
    return { found: true, response: saved.result };
  }
  return { found: true, response: saved };
}

export function requestResponse(result: unknown, requestHash?: string) {
  return requestHash ? { requestHash, result } : result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
