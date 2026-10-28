import { ConflictException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { ActivityAwardsRepository } from './activity-awards.repository.js';

function repositoryWithQuery(
  implementation: (sql: string, values?: unknown[]) => Promise<any>,
) {
  const release = vi.fn();
  const client = {
    query: vi.fn(implementation),
    release,
  } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { repository: new ActivityAwardsRepository(pool), client, release };
}

describe('ActivityAwardsRepository published revisions', () => {
  it('marks every version deleting and atomically queues a durable deletion job', async () => {
    const statements: { sql: string; values?: unknown[] }[] = [];
    const { repository } = repositoryWithQuery(async (sql, values) => {
      statements.push({ sql, values });
      if (sql.startsWith('SELECT response::text')) return { rows: [] };
      if (sql.includes('FROM activity_award_definition WHERE id=$1 FOR UPDATE'))
        return {
          rows: [
            {
              id: 'award-v2',
              programme_slug: 'field-day',
              code: 'FIELD-DAY-10',
              status: 'PUBLISHED',
            },
          ],
        };
      if (
        sql.includes('FROM activity_award_definition') &&
        sql.includes('ORDER BY version,id')
      )
        return {
          rows: [
            { id: 'award-v1', status: 'RETIRED' },
            { id: 'award-v2', status: 'PUBLISHED' },
          ],
        };
      if (sql.includes("kind='AWARD_DELETE'")) return { rows: [] };
      return { rows: [], rowCount: 1 };
    });

    await expect(
      repository.enqueueAwardDeletion(
        'award-v2',
        'global-admin-1',
        'delete-request-key',
      ),
    ).resolves.toMatchObject({
      kind: 'AWARD_DELETE',
      status: 'QUEUED',
      payload: {
        rootAwardId: 'award-v2',
        awardIds: ['award-v1', 'award-v2'],
        actorId: 'global-admin-1',
      },
    });
    expect(
      statements.some(
        (statement) =>
          statement.sql.includes("status='DELETING'") &&
          statement.sql.includes('programme_slug=$1 AND code=$2'),
      ),
    ).toBe(true);
    expect(
      statements.some((statement) =>
        statement.sql.includes("VALUES ($1,'AWARD_DELETE'"),
      ),
    ).toBe(true);
    expect(
      statements.some((statement) =>
        statement.sql.includes("'activity.award-delete.v1'"),
      ),
    ).toBe(true);
  });

  it('locks and verifies the source version before inserting a new draft', async () => {
    const statements: string[] = [];
    const { repository, release } = repositoryWithQuery(async (sql) => {
      statements.push(sql);
      if (sql.includes('SELECT definition::text') && sql.includes('FOR UPDATE'))
        return {
          rows: [
            {
              definition_text: JSON.stringify({
                id: 'old-id',
                programmeSlug: 'field-day',
                code: 'FIELD-DAY-10',
                version: 3,
                status: 'PUBLISHED',
              }),
            },
          ],
        };
      if (sql.startsWith('SELECT response::text')) return { rows: [] };
      return { rows: [], rowCount: 1 };
    });
    const record = {
      id: 'new-id',
      programmeSlug: 'field-day',
      code: 'FIELD-DAY-10',
      version: 4,
      status: 'DRAFT',
      revisionOf: 'old-id',
    };

    await expect(
      repository.createPublishedAwardRevision(
        'old-id',
        3,
        record,
        'revision-key',
      ),
    ).resolves.toEqual(record);

    expect(statements.some((sql) => sql.includes('FOR UPDATE'))).toBe(true);
    expect(
      statements.some((sql) =>
        sql.startsWith('INSERT INTO activity_award_definition'),
      ),
    ).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejects a stale source revision without inserting the new version', async () => {
    const statements: string[] = [];
    const { repository } = repositoryWithQuery(async (sql) => {
      statements.push(sql);
      if (sql.includes('SELECT definition::text') && sql.includes('FOR UPDATE'))
        return {
          rows: [
            {
              definition_text: JSON.stringify({
                id: 'old-id',
                programmeSlug: 'field-day',
                code: 'FIELD-DAY-10',
                version: 4,
                status: 'PUBLISHED',
              }),
            },
          ],
        };
      if (sql.startsWith('SELECT response::text')) return { rows: [] };
      return { rows: [], rowCount: 1 };
    });

    await expect(
      repository.createPublishedAwardRevision(
        'old-id',
        3,
        {
          id: 'new-id',
          programmeSlug: 'field-day',
          code: 'FIELD-DAY-10',
          version: 4,
          status: 'DRAFT',
        },
        'revision-key',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      statements.some((sql) =>
        sql.startsWith('INSERT INTO activity_award_definition'),
      ),
    ).toBe(false);
  });

  it('lists only the currently effective published version to public clients', async () => {
    let queryText = '';
    const { repository } = repositoryWithQuery(async (sql) => {
      queryText = sql;
      return { rows: [{ value: '0', definition_text: null }] };
    });

    await repository.listAwardDefinitionsPage(
      undefined,
      undefined,
      true,
      0n,
      50,
    );

    expect(queryText).toContain("award.status='PUBLISHED'");
    expect(queryText).toContain('award.effective_from <= now()');
    expect(queryText).toContain('newer.version > award.version');
  });
});
