import type { Pool, PoolClient } from 'pg';
import { ActivityRepository } from './activity.repository.js';

describe('ActivityRepository work-job redrive', () => {
  it('preserves delivery attempts when requeueing a failed job', async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const jobId = '44444444-4444-4444-8444-444444444444';
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.includes('FROM activity_job WHERE id=$1 FOR UPDATE'))
          return {
            rows: [
              {
                id: jobId,
                kind: 'QSO_INGESTION',
                status: 'FAILED',
                attempts: 4,
              },
            ],
            rowCount: 1,
          };
        return { rows: [], rowCount: 1 };
      },
      release: () => undefined,
    } as unknown as PoolClient;
    const pool = { connect: async () => client } as unknown as Pool;
    const repository = new ActivityRepository(pool);

    const result = await repository.redriveFailedWorkJob(
      jobId,
      'admin-1',
      'Investigate failed delivery',
    );

    expect(result).toMatchObject({ jobId, status: 'QUEUED' });
    const requeue = queries.find((query) =>
      query.sql.includes("UPDATE activity_job SET status='QUEUED'"),
    );
    expect(requeue?.sql).not.toContain('attempts=');
    expect(queries.some((query) => query.sql === 'COMMIT')).toBe(true);
  });
});
