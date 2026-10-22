import type { Pool, PoolClient } from 'pg';
import { S3Client } from '@aws-sdk/client-s3';
import { ActivityWorkRepository } from './activity-work.repository.js';

describe('ActivityWorkRepository ADIF failure notifications', () => {
  async function finishFailedImport(reason: string) {
    const queries: { sql: string; values: unknown[] }[] = [];
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.startsWith('UPDATE activity_import')) {
          return {
            rows: [
              {
                id: 'import-1',
                activation_id: 'activation-1',
                filename: 'log.adi',
                object_key: 'imports/log.adi',
                bucket: 'activity-imports',
                sha256: 'hash',
                content_size: '1',
                malware_status: 'CLEAN',
                status: 'FAILED',
                records_seen: 0,
                records_accepted: 0,
                records_rejected: 1,
              },
            ],
          };
        }
        return { rows: [] };
      },
    } as unknown as PoolClient;
    const repository = new ActivityWorkRepository(null);
    const internal = repository as unknown as {
      finishAdifImport: (
        db: PoolClient,
        record: Record<string, unknown>,
        seen: number,
        accepted: number,
        rejected: number,
        errors: string[],
        status: string,
      ) => Promise<unknown>;
    };

    await internal.finishAdifImport(
      client,
      { id: 'import-1', activation_id: 'activation-1' },
      0,
      0,
      1,
      [reason],
      'FAILED',
    );
    return queries;
  }

  it('addresses a missing-object notice to the activation ID with the Python reason', async () => {
    const queries = await finishFailedImport(
      'uploaded object is not available',
    );
    const notification = queries[1];

    expect(notification?.sql).toContain('ADIF_IMPORT_FAILED');
    expect(notification?.values[1]).toBe('activation-1');
    expect(JSON.parse(String(notification?.values[2]))).toEqual({
      importId: 'import-1',
      reason: 'object unavailable',
    });
  });

  it('preserves the parser error as the notification reason', async () => {
    const queries = await finishFailedImport('invalid ADIF record');
    const notification = queries[1];

    expect(notification?.values[1]).toBe('activation-1');
    expect(JSON.parse(String(notification?.values[2]))).toEqual({
      importId: 'import-1',
      reason: 'invalid ADIF record',
    });
  });

  it('maps object-store read failures to the Python missing-object result', async () => {
    const queries: { sql: string; values: unknown[] }[] = [];
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.startsWith('SELECT i.*'))
          return {
            rows: [
              {
                id: 'import-1',
                activation_id: 'activation-1',
                filename: 'log.adi',
                object_key: 'adif/activation-1/log.adi',
                bucket: 'myota-adif',
                status: 'QUEUED',
                operator_id: 'operator-1',
                activation_status: 'OPEN',
              },
            ],
          };
        if (sql.startsWith('UPDATE activity_import'))
          return {
            rows: [
              {
                id: 'import-1',
                activation_id: 'activation-1',
                filename: 'log.adi',
                object_key: 'adif/activation-1/log.adi',
                bucket: 'myota-adif',
                sha256: 'hash',
                content_size: '10',
                malware_status: 'CLEAN',
                status: 'FAILED',
                records_seen: 0,
                records_accepted: 0,
                records_rejected: 1,
                errors: ['uploaded object is not available'],
                created_at: new Date('2026-01-01T00:00:00Z'),
                started_at: new Date('2026-01-01T00:00:01Z'),
                completed_at: new Date('2026-01-01T00:00:02Z'),
              },
            ],
          };
        return { rows: [] };
      },
    } as unknown as PoolClient;
    const read = vi
      .spyOn(S3Client.prototype, 'send')
      .mockRejectedValue(new Error('object storage unavailable'));
    const repository = new ActivityWorkRepository(null);
    const internal = repository as unknown as {
      processAdifImport: (
        db: PoolClient,
        payload: Record<string, unknown>,
      ) => Promise<void>;
    };

    try {
      await internal.processAdifImport(client, { importId: 'import-1' });
      expect(read).toHaveBeenCalledOnce();
    } finally {
      read.mockRestore();
    }

    const finish = queries.find(({ sql }) =>
      sql.startsWith('UPDATE activity_import'),
    );
    expect(finish?.values.slice(1, 5)).toEqual(['FAILED', 0, 0, 1]);
    expect(JSON.parse(String(finish?.values[5]))).toEqual([
      'uploaded object is not available',
    ]);
    const notification = queries.find(({ sql }) =>
      sql.includes("'ADIF_IMPORT_FAILED'"),
    );
    expect(notification?.values[1]).toBe('activation-1');
    expect(JSON.parse(String(notification?.values[2]))).toEqual({
      importId: 'import-1',
      reason: 'object unavailable',
    });
  });
});

describe('ActivityWorkRepository transient connection errors', () => {
  it('preserves the pool connection error as the unavailable cause', async () => {
    const cause = Object.assign(new Error('read ECONNRESET'), {
      code: 'ECONNRESET',
    });
    const pool = {
      connect: async () => {
        throw cause;
      },
    };
    const repository = new ActivityWorkRepository(pool as unknown as Pool);

    await expect(
      repository.claimWorkJob(
        '0199c125-c321-7220-a123-456789abcdef',
        'STATISTICS_REBUILD',
      ),
    ).rejects.toMatchObject({
      message: 'Activity database is unavailable',
      cause,
    });
  });
});

describe('ActivityWorkRepository retry dispatch', () => {
  it('commits a fresh work outbox event with the queued retry state', async () => {
    const availableAt = new Date('2026-10-22T12:00:02.000Z');
    const queries: { sql: string; values: unknown[] }[] = [];
    const client = {
      query: vi.fn(async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.startsWith('UPDATE activity_job'))
          return { rowCount: 1, rows: [{ available_at: availableAt }] };
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
    };
    const repository = new ActivityWorkRepository(pool as unknown as Pool);

    await repository.retryWorkJob(
      {
        id: '0199c125-c321-7220-a123-456789abcdef',
        kind: 'STATISTICS_REBUILD',
        payload: { programmeSlug: 'retry-test' },
        attempts: 1,
        leaseToken: '0199c125-c321-7220-a123-456789abcdee',
      },
      new Error('temporary failure'),
      2,
    );

    const outbox = queries.find(({ sql }) =>
      sql.startsWith('INSERT INTO outbox_event'),
    );
    expect(outbox?.values[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(outbox?.values.slice(1)).toEqual([
      'activity.statistics-rebuild.v1',
      '0199c125-c321-7220-a123-456789abcdef',
      JSON.stringify({ jobId: '0199c125-c321-7220-a123-456789abcdef' }),
      availableAt,
    ]);
    expect(queries.at(-1)?.sql).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });
});
