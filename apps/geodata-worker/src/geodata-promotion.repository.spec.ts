import type { PoolClient } from 'pg';
import { GeodataPromotionScoring } from './geodata-promotion-scoring.js';
import {
  GeodataPromotionRepository,
  type PromotionQueue,
} from './geodata-promotion.repository.js';

describe('GeodataPromotionRepository transactional candidate mutation', () => {
  const candidateId = '22222222-2222-4222-8222-222222222222';
  const entityId = '33333333-3333-4333-8333-333333333333';
  const runId = '11111111-1111-4111-8111-111111111111';

  function harness(existingIdentifier: string | null = null) {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const outbox: Array<{ sql: string; values: unknown[] }> = [];
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.includes('AS timestamp'))
          return { rows: [{ timestamp: '2026-10-23T12:00:00.000000Z' }] };
        if (sql.includes('SELECT * FROM geodata_import_candidate'))
          return {
            rows: [
              {
                id: candidateId,
                import_run_id: runId,
                validation_status: 'CONFIRMED',
                processing_queue_id: null,
                entity_type_codes: ['SOTA'],
                entity_payload: {
                  geometry: {
                    type: 'Point',
                    coordinates: [7.1, 46.2],
                  },
                  jurisdiction: 'DL',
                  website: 'https://example.test',
                  description: 'Imported summit',
                },
                candidate_source: { sourceKey: 'fixture' },
                source_ref: 'fixture:record-1',
                source_hash: 'sha256:fixture',
                programme_slug: 'alpine',
                ordinal: 1,
                name: 'Fixture summit',
                existing_entity_id: existingIdentifier ? entityId : null,
                planned_entity_id: entityId,
              },
            ],
          };
        if (sql.includes('SELECT adapter_code,source_metadata FROM import_run'))
          return {
            rows: [
              {
                adapter_code: 'MANUAL',
                source_metadata: {
                  source: {
                    sourceKey: 'fixture',
                    url: 'https://example.test/source.geojson',
                    license: 'CC BY 4.0',
                    attribution: 'Test fixture',
                  },
                },
              },
            ],
          };
        if (sql.includes('SELECT entity_id FROM source_reference'))
          return { rows: [] };
        if (sql.includes('SELECT lifecycle_status,website,description'))
          return {
            rows: existingIdentifier
              ? [
                  {
                    lifecycle_status: 'CANDIDATE',
                    website: null,
                    description: null,
                    public_properties: {},
                    entity_identifier: existingIdentifier,
                  },
                ]
              : [],
          };
        if (sql.includes('SELECT id FROM entity_type'))
          return { rows: [{ id: '44444444-4444-4444-8444-444444444444' }] };
        if (sql.includes('FROM geodata_entity candidate')) return { rows: [] };
        if (sql.includes('SELECT ST_AsGeoJSON(geom)')) return { rows: [] };
        if (sql.includes('INSERT INTO outbox_event'))
          outbox.push({ sql, values });
        return { rows: [], rowCount: 1 };
      },
    } as unknown as PoolClient;
    return { queries, outbox, client };
  }

  it('applies a selected candidate in the caller transaction and emits Geodata API facts', async () => {
    const fixture = harness();
    const repository = new GeodataPromotionRepository(
      null,
      new GeodataPromotionScoring(),
    );
    const queue: PromotionQueue = {
      id: '',
      import_run_id: runId,
      candidate_ids: [candidateId],
      target_status: 'CANDIDATE',
      requested_by: 'reviewer-1',
      job_metadata: { note: 'Reviewed in Admin' },
      attempt_count: 0,
    };

    const result = await repository.promoteCandidateInTransaction(
      fixture.client,
      queue,
      candidateId,
    );

    expect(result).toEqual({ entityId, updated: false });
    expect(
      fixture.queries.some((query) =>
        query.sql.includes(
          'FROM geodata_import_processing_queue WHERE id=$1 FOR UPDATE',
        ),
      ),
    ).toBe(false);
    expect(
      fixture.queries.some((query) =>
        query.sql.startsWith('INSERT INTO geodata_entity'),
      ),
    ).toBe(true);
    expect(
      fixture.queries.some((query) =>
        query.sql.includes("validation_status='PROCESSED'"),
      ),
    ).toBe(true);
    expect(fixture.outbox).toHaveLength(1);
    expect(fixture.outbox[0]?.values[1]).toBe(
      'geodata.entity.candidate.created.v1',
    );
    expect(fixture.outbox[0]?.values[7]).toBe('geodata-service');
    expect(
      fixture.queries.some((query) =>
        ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(query.sql),
      ),
    ).toBe(false);
  });

  it('preserves an assigned programme ID when a scoped source promotion updates its entity', async () => {
    const existingIdentifier = 'ALPINE-007';
    const fixture = harness(existingIdentifier);
    const repository = new GeodataPromotionRepository(
      null,
      new GeodataPromotionScoring(),
    );
    const queue: PromotionQueue = {
      id: '',
      import_run_id: runId,
      candidate_ids: [candidateId],
      target_status: 'CANDIDATE',
      requested_by: 'reviewer-1',
      job_metadata: { note: 'Programme-scoped source refresh' },
      attempt_count: 0,
    };

    const result = await repository.promoteCandidateInTransaction(
      fixture.client,
      queue,
      candidateId,
    );

    expect(result).toEqual({ entityId, updated: true });
    const entityUpsert = fixture.queries.find((query) =>
      query.sql.startsWith('INSERT INTO geodata_entity'),
    );
    expect(entityUpsert?.sql).toContain(
      'entity_identifier=COALESCE(geodata_entity.entity_identifier,EXCLUDED.entity_identifier)',
    );
    expect(entityUpsert?.values.at(-1)).toBe(existingIdentifier);
    expect(entityUpsert?.values[9]).toBe('alpine');
  });
});
