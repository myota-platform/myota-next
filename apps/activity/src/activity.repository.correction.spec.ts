import type { Pool, PoolClient } from 'pg';
import { ActivityRepository } from './activity.repository.js';

describe('ActivityRepository QSO correction review', () => {
  it('applies proposed fields to the correction QSO and queues recalculation', async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const correctionId = '11111111-1111-4111-8111-111111111111';
    const qsoId = '22222222-2222-4222-8222-222222222222';
    const correction = {
      id: correctionId,
      qso_id: qsoId,
      requested_by: 'participant-1',
      reason: 'Correct callsign and time',
      proposed_values: {
        workedCallsign: 'F4XYZ',
        occurredAt: '2026-10-21T10:20:30Z',
        ignoredField: 'not writable',
      },
      proposed_values_text: JSON.stringify({
        workedCallsign: 'F4XYZ',
        occurredAt: '2026-10-21T10:20:30Z',
        ignoredField: 'not writable',
      }),
      status: 'PENDING',
      reviewed_by: null,
      review_note: null,
      created_at: new Date('2026-10-21T10:30:00Z'),
      reviewed_at: null,
    };
    const qso = {
      id: qsoId,
      programme_slug: 'alpine',
      operator_id: 'operator-1',
      hunter_id: 'hunter-1',
    };
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.includes('FROM activity_qso_correction WHERE id=$1')) {
          return { rows: [correction], rowCount: 1 };
        }
        if (sql.includes('SELECT * FROM activity_qso WHERE id=$1')) {
          return { rows: [qso], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO activity_job')) {
          return {
            rows: [{ id: '33333333-3333-4333-8333-333333333333' }],
            rowCount: 1,
          };
        }
        if (sql.includes('UPDATE activity_qso_correction')) {
          return {
            rows: [
              {
                ...correction,
                status: values[0],
                reviewed_by: values[1],
                review_note: values[2],
                reviewed_at: new Date('2026-10-21T10:31:00Z'),
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      },
      release: () => undefined,
    } as unknown as PoolClient;
    const pool = { connect: async () => client } as unknown as Pool;
    const repository = new ActivityRepository(pool);

    const result = await repository.reviewCorrection(
      'wrong-nested-qso-id',
      correctionId,
      { decision: 'APPLIED', reviewedBy: 'admin-1', reviewNote: 'Verified' },
    );

    expect(result).toMatchObject({
      id: correctionId,
      qsoId,
      status: 'APPLIED',
      reviewedBy: 'admin-1',
      reviewNote: 'Verified',
    });
    const qsoUpdate = queries.find((item) =>
      item.sql.startsWith('UPDATE activity_qso SET'),
    );
    expect(qsoUpdate?.sql).toContain("status='CORRECTED'");
    expect(qsoUpdate?.values).toEqual(['F4XYZ', '2026-10-21T10:20:30Z', qsoId]);
    expect(
      queries
        .find((item) => item.sql.includes('INSERT INTO activity_job'))
        ?.values.slice(1),
    ).toEqual([
      'AWARD_RECALCULATE',
      JSON.stringify({
        programmeSlug: 'alpine',
        subjectIds: ['operator-1', 'hunter-1'],
      }),
      `correction:${correctionId}`,
    ]);
    expect(queries.some((item) => item.sql === 'COMMIT')).toBe(true);
  });
});
