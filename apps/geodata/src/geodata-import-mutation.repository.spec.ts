import { BadRequestException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { GeodataImportMutationRepository } from './geodata-import-mutation.repository.js';

describe('GeodataImportMutationRepository candidate validation parity', () => {
  const runId = '11111111-1111-4111-8111-111111111111';
  const firstId = '22222222-2222-4222-8222-222222222222';
  const secondId = '33333333-3333-4333-8333-333333333333';

  function harness(selectedRows: Array<Record<string, unknown>>) {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const outboxPayloads: Array<Record<string, unknown>> = [];
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.includes('SELECT id,validation_status,processing_queue_id'))
          return { rows: selectedRows, rowCount: selectedRows.length };
        if (sql.includes('INSERT INTO outbox_event')) {
          outboxPayloads.push(
            JSON.parse(String(values[3])) as Record<string, unknown>,
          );
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
      release: () => undefined,
    } as unknown as PoolClient;
    const repository = new GeodataImportMutationRepository({
      connect: async () => client,
    } as unknown as Pool);
    return { repository, queries, outboxPayloads };
  }

  it('confirms candidates transactionally and preserves submitted ID order in the event', async () => {
    const fixture = harness([
      { id: firstId, validation_status: 'PENDING', processing_queue_id: null },
      { id: secondId, validation_status: 'PENDING', processing_queue_id: null },
    ]);

    const result = await fixture.repository.validateImportCandidates(
      runId,
      undefined,
      {
        candidateIds: [firstId, secondId, firstId],
        reviewerId: 'reviewer-1',
        validationStatus: 'confirmed',
        note: 'Checked against the source map',
      },
    );

    expect(result).toEqual({
      importRunId: runId,
      candidateIds: [firstId, secondId, firstId],
      validationStatus: 'CONFIRMED',
    });
    const selection = fixture.queries.find((query) =>
      query.sql.includes('SELECT id,validation_status,processing_queue_id'),
    );
    expect(selection?.values).toEqual([runId, [firstId, secondId]]);
    const update = fixture.queries.find((query) =>
      query.sql.includes("validation_status='CONFIRMED'"),
    );
    expect(update?.values).toEqual([
      runId,
      [firstId, secondId],
      '"Checked against the source map"',
      'reviewer-1',
    ]);
    expect(fixture.outboxPayloads).toEqual([
      {
        importRunId: runId,
        candidateIds: [firstId, secondId, firstId],
        reviewerId: 'reviewer-1',
      },
    ]);
    expect(fixture.queries[0].sql).toBe('BEGIN');
    expect(fixture.queries.at(-1)?.sql).toBe('COMMIT');
  });

  it('rejects queued candidates before deleting or emitting an event', async () => {
    const fixture = harness([
      {
        id: firstId,
        validation_status: 'CONFIRMED',
        processing_queue_id: 'queue-1',
      },
    ]);

    await expect(
      fixture.repository.validateImportCandidates(runId, undefined, {
        candidateIds: [firstId],
        reviewerId: 'reviewer-1',
        validationStatus: 'REJECTED',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(
      fixture.queries.some((query) =>
        query.sql.startsWith('DELETE FROM geodata_import_candidate'),
      ),
    ).toBe(false);
    expect(fixture.outboxPayloads).toEqual([]);
    expect(fixture.queries.at(-1)?.sql).toBe('ROLLBACK');
  });
});
