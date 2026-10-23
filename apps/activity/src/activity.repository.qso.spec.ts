import type { Pool, PoolClient } from 'pg';
import { ActivityRepository } from './activity.repository.js';

describe('ActivityRepository QSO insertion', () => {
  it('returns duplicate QSOs without repeating aggregates, events, or award work', async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const activationId = '11111111-1111-4111-8111-111111111111';
    const qsoId = '22222222-2222-4222-8222-222222222222';
    const deduplicationKey = 'same-qso-key';
    const existing = {
      id: qsoId,
      activation_id: activationId,
      programme_slug: 'field-day',
      operator_id: 'operator-1',
      operator_callsign: 'N1ABC',
      hunter_id: null,
      hunter_callsign: null,
      worked_callsign: 'K1XYZ',
      worked_station_key: 'K1XYZ|',
      worked_entity_id: null,
      occurred_at_iso: '2026-01-02T00:00:00.000000Z',
      band: '20M',
      mode: 'SSB',
      rst: null,
      source: 'manual',
      status: 'ACTIVE',
      deduplication_key: deduplicationKey,
      created_at_iso: '2026-01-02T00:00:01.000000Z',
    };
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.includes('FROM activity_activation WHERE id=$1 FOR UPDATE')) {
          return {
            rows: [
              {
                id: activationId,
                status: 'OPEN',
                programme_slug: 'field-day',
                operator_id: 'operator-1',
                operator_callsign: 'N1ABC',
                qso_before_start: false,
                qso_after_expiry: false,
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('INSERT INTO activity_qso')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('FROM activity_qso WHERE deduplication_key=$1')) {
          return { rows: [existing], rowCount: 1 };
        }
        if (sql.includes('SELECT qso_count FROM activity_activation')) {
          return { rows: [{ qso_count: '7' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    } as unknown as PoolClient;
    const repository = new ActivityRepository({
      connect: async () => client,
    } as unknown as Pool);

    const result = await repository.addQso(activationId, {
      id: '33333333-3333-4333-8333-333333333333',
      timestamp: '2026-01-02T00:00:00.000000Z',
      deduplicationKey,
      workedCallsign: 'K1XYZ',
      workedStationKey: 'K1XYZ|',
      band: '20M',
      mode: 'SSB',
      source: 'manual',
    });

    expect(result).toMatchObject({
      activationId,
      qso: { id: qsoId, workedCallsign: 'K1XYZ' },
      qsoCount: 7,
      duplicate: true,
    });
    expect(
      queries.some((query) =>
        /INSERT INTO activity_subject_|UPDATE activity_activation SET/.test(
          query.sql,
        ),
      ),
    ).toBe(false);
    expect(
      queries.some((query) =>
        /INSERT INTO (outbox_event|activity_job)/.test(query.sql),
      ),
    ).toBe(false);
    expect(queries.some((query) => query.sql === 'COMMIT')).toBe(true);
  });
});
