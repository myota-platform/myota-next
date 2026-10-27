import type { Pool, PoolClient } from 'pg';
import { ActivityRepository } from './activity.repository.js';

describe('ActivityRepository activation details', () => {
  it('returns stored QSO source links and ADIF import outcomes with activation details', async () => {
    const activationId = '11111111-1111-4111-8111-111111111111';
    const importId = '22222222-2222-4222-8222-222222222222';
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('FROM activity_activation WHERE id=$1')) {
          return {
            rows: [
              {
                id: activationId,
                programme_slug: 'part_jud_es',
                entity_id: '33333333-3333-4333-8333-333333333333',
                entity_type: 'PART_JUD',
                jurisdiction_code: null,
                operator_id: 'participant-1',
                operator_callsign: 'EA7QAT',
                started_at_iso: '2026-10-27T06:00:00.000000Z',
                ended_at_iso: '2026-10-27T07:00:00.000000Z',
                validity_expires_at_iso: null,
                status: 'CLOSED',
                location_text: '{}',
                programme_rules_text: '{}',
                rule_evaluation_text: '{}',
                qso_count: '1',
                unique_callsign_count: '1',
                unique_entity_count: '0',
                created_at_iso: '2026-10-27T06:00:00.000000Z',
                updated_at_iso: '2026-10-27T07:00:00.000000Z',
              },
            ],
          };
        }
        if (sql.includes('FROM activity_qso WHERE activation_id=$1')) {
          return {
            rows: [
              {
                id: '44444444-4444-4444-8444-444444444444',
                activation_id: activationId,
                programme_slug: 'part_jud_es',
                operator_id: 'participant-1',
                operator_callsign: 'EA7QAT',
                hunter_id: null,
                hunter_callsign: null,
                worked_callsign: 'F4XYZ',
                worked_station_key: 'F4XYZ|',
                worked_entity_id: null,
                occurred_at_iso: '2026-10-27T06:30:00.000000Z',
                band: '20M',
                mode: 'SSB',
                rst: null,
                source: 'ADIF',
                source_import_id: importId,
                status: 'ACTIVE',
                deduplication_key: 'test-deduplication-key',
                created_at_iso: '2026-10-27T06:30:00.000000Z',
              },
            ],
          };
        }
        if (sql.includes('FROM activity_import WHERE activation_id=$1')) {
          return {
            rows: [
              {
                id: importId,
                filename: 'contacts.adi',
                status: 'COMPLETED',
                records_seen: 1,
                records_accepted: 1,
                records_rejected: 0,
                created_at_iso: '2026-10-27T06:20:00.000000Z',
                started_at_iso: '2026-10-27T06:20:01.000000Z',
                completed_at_iso: '2026-10-27T06:20:02.000000Z',
              },
            ],
          };
        }
        return { rows: [] };
      },
      release: () => undefined,
    } as unknown as PoolClient;
    const repository = new ActivityRepository({
      connect: async () => client,
    } as unknown as Pool);

    const result = await repository.get(activationId);

    expect(result).toMatchObject({
      id: activationId,
      status: 'CLOSED',
      qsos: [
        {
          workedCallsign: 'F4XYZ',
          source: 'ADIF',
          sourceImportId: importId,
        },
      ],
      imports: [
        {
          id: importId,
          filename: 'contacts.adi',
          status: 'COMPLETED',
          recordsSeen: 1,
          recordsAccepted: 1,
          recordsRejected: 0,
        },
      ],
    });
    expect(queries.some((sql) => sql.includes('FROM activity_import'))).toBe(
      true,
    );
  });
});
