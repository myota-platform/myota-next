import { BadRequestException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { GeodataImportMutationRepository } from './geodata-import-mutation.repository.js';

describe('GeodataImportMutationRepository candidate validation parity', () => {
  const runId = '11111111-1111-4111-8111-111111111111';
  const firstId = '22222222-2222-4222-8222-222222222222';
  const secondId = '33333333-3333-4333-8333-333333333333';

  function harness(
    selectedRows: Array<Record<string, unknown>>,
    previousQueueRows: Array<Record<string, unknown>> = [],
  ) {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const outboxPayloads: Array<Record<string, unknown>> = [];
    const promoted: Array<{ client: PoolClient; queue: unknown; id: string }> =
      [];
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.includes('FROM geodata_import_processing_queue q'))
          return {
            rows: previousQueueRows,
            rowCount: previousQueueRows.length,
          };
        if (sql.includes('SELECT c.id,c.programme_slug,c.entity_type_codes'))
          return { rows: selectedRows, rowCount: selectedRows.length };
        if (sql.includes("FILTER (WHERE validation_status='PROCESSED'"))
          return {
            rows: [{ created: '2', updated: '0', remaining: '0' }],
            rowCount: 1,
          };
        if (sql.includes('\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\''))
          return { rows: [{ timestamp: '2026-10-23T12:00:00.000000Z' }] };
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
    const promotion = {
      loadProgrammeNumberingPolicies: async () => new Map(),
      promoteCandidateInTransaction: async (
        transaction: PoolClient,
        queue: unknown,
        id: string,
      ) => {
        promoted.push({ client: transaction, queue, id });
        return { entityId: `entity-${id}`, updated: false };
      },
    };
    const repository = new GeodataImportMutationRepository(
      {
        connect: async () => client,
      } as unknown as Pool,
      promotion as never,
    );
    return { repository, queries, outboxPayloads, promoted, promotion };
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

  it('promotes a selected set in one transaction without writing a queue', async () => {
    const fixture = harness([
      {
        id: firstId,
        programme_slug: 'alpine',
        entity_type_codes: ['SOTA'],
        entity_payload: { jurisdiction: 'DL' },
        validation_status: 'PENDING',
        processing_queue_id: null,
      },
      {
        id: secondId,
        programme_slug: 'alpine',
        entity_type_codes: ['SOTA'],
        entity_payload: { jurisdiction: 'DL' },
        validation_status: 'CONFIRMED',
        processing_queue_id: null,
      },
    ]);

    const result = await fixture.repository.processImportCandidates(
      runId,
      undefined,
      {
        candidateIds: [firstId, secondId],
        targetStatus: 'CANDIDATE',
        processorId: 'reviewer-1',
      },
      { sub: 'reviewer-1', scp: ['geodata.import'] } as never,
    );

    expect(result).toMatchObject({
      importRunId: runId,
      candidateIds: [firstId, secondId],
      targetStatus: 'CANDIDATE',
      requestedBy: 'reviewer-1',
      status: 'COMPLETED',
      created: [`entity-${firstId}`, `entity-${secondId}`],
      updated: [],
    });
    expect(fixture.promoted.map((entry) => entry.id)).toEqual([
      firstId,
      secondId,
    ]);
    expect(new Set(fixture.promoted.map((entry) => entry.client)).size).toBe(1);
    expect(
      fixture.promoted.every(
        (entry) => (entry.queue as { id: string }).id === '',
      ),
    ).toBe(true);
    expect(
      fixture.queries.some((query) =>
        query.sql.includes('INSERT INTO geodata_import_processing_queue'),
      ),
    ).toBe(false);
    expect(fixture.queries[0].sql).toBe('BEGIN');
    expect(fixture.queries.at(-1)?.sql).toBe('COMMIT');
  });

  it('retries a candidate only when its previous queue failed that candidate', async () => {
    const fixture = harness(
      [
        {
          id: firstId,
          programme_slug: 'alpine',
          entity_type_codes: ['SOTA'],
          entity_payload: { jurisdiction: 'DL' },
          validation_status: 'CONFIRMED',
          processing_queue_id: 'queue-1',
        },
      ],
      [
        {
          id: 'queue-1',
          status: 'FAILED',
          result: { errors: [{ candidateId: firstId, message: 'temporary' }] },
        },
      ],
    );

    const result = await fixture.repository.processImportCandidates(
      runId,
      undefined,
      {
        candidateIds: [firstId],
        targetStatus: 'CANDIDATE',
        processorId: 'reviewer-1',
      },
      { sub: 'reviewer-1', scp: ['geodata.import'] } as never,
    );

    expect(result).toMatchObject({
      status: 'COMPLETED',
      created: [`entity-${firstId}`],
    });
    const queueLock = fixture.queries.findIndex((query) =>
      query.sql.includes('FROM geodata_import_processing_queue q'),
    );
    const candidateLock = fixture.queries.findIndex((query) =>
      query.sql.includes('SELECT c.id,c.programme_slug,c.entity_type_codes'),
    );
    expect(queueLock).toBeGreaterThan(-1);
    expect(candidateLock).toBeGreaterThan(queueLock);
    expect(
      fixture.queries.some(
        (query) =>
          query.sql.includes("SET validation_status='CONFIRMED'") &&
          query.sql.includes('processing_queue_id=NULL'),
      ),
    ).toBe(true);
  });

  it('rejects retry while the prior promotion queue is active', async () => {
    const fixture = harness(
      [
        {
          id: firstId,
          validation_status: 'CONFIRMED',
          processing_queue_id: 'queue-1',
        },
      ],
      [{ id: 'queue-1', status: 'PROCESSING', result: {} }],
    );

    await expect(
      fixture.repository.processImportCandidates(
        runId,
        undefined,
        {
          candidateIds: [firstId],
          targetStatus: 'CANDIDATE',
          processorId: 'reviewer-1',
        },
        { sub: 'reviewer-1', scp: ['geodata.import'] } as never,
      ),
    ).rejects.toThrow('record is already promoted or queued');

    expect(fixture.promoted).toEqual([]);
    expect(fixture.queries.at(-1)?.sql).toBe('ROLLBACK');
  });

  it('authorizes each sorted candidate before resolving later selected IDs', async () => {
    const fixture = harness([
      {
        id: firstId,
        programme_slug: 'alpine',
        entity_type_codes: ['SOTA'],
        entity_payload: { jurisdiction: 'DL' },
        validation_status: 'PENDING',
        processing_queue_id: null,
      },
    ]);

    await expect(
      fixture.repository.processImportCandidates(
        runId,
        undefined,
        {
          candidateIds: [firstId, secondId],
          targetStatus: 'APPROVED',
          processorId: 'reviewer-1',
        },
        { sub: 'reviewer-1', scp: ['geodata.review'], roles: [] } as never,
      ),
    ).rejects.toThrow('approver scope does not cover this entity');

    expect(fixture.promoted).toEqual([]);
    expect(fixture.queries.at(-1)?.sql).toBe('ROLLBACK');
  });

  it('does not retry a failed queue candidate unless its state is confirmed', async () => {
    const fixture = harness(
      [
        {
          id: firstId,
          validation_status: 'PENDING',
          processing_queue_id: 'queue-1',
        },
      ],
      [
        {
          id: 'queue-1',
          status: 'FAILED',
          result: { errors: [{ candidateId: firstId, message: 'temporary' }] },
        },
      ],
    );

    await expect(
      fixture.repository.processImportCandidates(
        runId,
        undefined,
        {
          candidateIds: [firstId],
          targetStatus: 'CANDIDATE',
          processorId: 'reviewer-1',
        },
        { sub: 'reviewer-1', scp: ['geodata.import'] } as never,
      ),
    ).rejects.toThrow('record is already promoted or queued');

    expect(fixture.promoted).toEqual([]);
    expect(fixture.queries.at(-1)?.sql).toBe('ROLLBACK');
  });

  it('rejects a selection above the synchronous limit before opening a transaction', async () => {
    const fixture = harness([]);
    const candidateIds = Array.from({ length: 301 }, (_, index) => {
      const suffix = String(index + 1).padStart(12, '0');
      return `00000000-0000-4000-8000-${suffix}`;
    });

    await expect(
      fixture.repository.processImportCandidates(
        runId,
        undefined,
        {
          candidateIds,
          targetStatus: 'CANDIDATE',
          processorId: 'reviewer-1',
        },
        { sub: 'reviewer-1', scp: ['geodata.import'] } as never,
      ),
    ).rejects.toThrow('at most 300 candidates');
    expect(fixture.queries).toEqual([]);
  });

  it('applies the synchronous limit after deduplicating the selection', async () => {
    const fixture = harness([
      {
        id: firstId,
        programme_slug: 'alpine',
        entity_type_codes: ['SOTA'],
        entity_payload: { jurisdiction: 'DL' },
        validation_status: 'PENDING',
        processing_queue_id: null,
      },
    ]);

    const result = await fixture.repository.processImportCandidates(
      runId,
      undefined,
      {
        candidateIds: Array.from({ length: 301 }, () => firstId),
        targetStatus: 'CANDIDATE',
        processorId: 'reviewer-1',
      },
      { sub: 'reviewer-1', scp: ['geodata.import'] } as never,
    );

    expect(result.candidateIds).toEqual([firstId]);
    expect(fixture.promoted.map((entry) => entry.id)).toEqual([firstId]);
  });

  it('preserves candidate-list and target-status validation order', async () => {
    const malformedList = harness([]);

    await expect(
      malformedList.repository.processImportCandidates(
        runId,
        undefined,
        {
          candidateIds: 'not-a-list',
          targetStatus: 'INVALID',
          processorId: 'reviewer-1',
        },
        { sub: 'reviewer-1', scp: ['geodata.import'] } as never,
      ),
    ).rejects.toThrow('candidateIds must be a non-empty list');

    expect(malformedList.queries).toEqual([]);

    const overLimit = harness([]);
    const candidateIds = Array.from({ length: 301 }, (_, index) => {
      const suffix = String(index + 1).padStart(12, '0');
      return `00000000-0000-4000-8000-${suffix}`;
    });
    await expect(
      overLimit.repository.processImportCandidates(
        runId,
        undefined,
        { candidateIds, targetStatus: 'INVALID', processorId: 'reviewer-1' },
        { sub: 'reviewer-1', scp: ['geodata.import'] } as never,
      ),
    ).rejects.toThrow('targetStatus must be CANDIDATE or APPROVED');
    expect(overLimit.queries).toEqual([]);
  });

  it('rolls back every selected promotion if a later candidate fails', async () => {
    const fixture = harness([
      {
        id: firstId,
        programme_slug: 'alpine',
        entity_type_codes: ['SOTA'],
        entity_payload: {},
        validation_status: 'PENDING',
        processing_queue_id: null,
      },
      {
        id: secondId,
        programme_slug: 'alpine',
        entity_type_codes: ['SOTA'],
        entity_payload: {},
        validation_status: 'PENDING',
        processing_queue_id: null,
      },
    ]);
    const original = fixture.promotion.promoteCandidateInTransaction;
    let calls = 0;
    fixture.promotion.promoteCandidateInTransaction = async (...args) => {
      calls++;
      if (calls === 2) throw new BadRequestException('candidate conflict');
      return original(...args);
    };

    await expect(
      fixture.repository.processImportCandidates(
        runId,
        undefined,
        {
          candidateIds: [firstId, secondId],
          targetStatus: 'CANDIDATE',
          processorId: 'reviewer-1',
        },
        { sub: 'reviewer-1', scp: ['geodata.import'] } as never,
      ),
    ).rejects.toThrow('candidate conflict');
    expect(fixture.queries.at(-1)?.sql).toBe('ROLLBACK');
    expect(fixture.queries.some((query) => query.sql === 'COMMIT')).toBe(false);
  });
});

describe('GeodataImportMutationRepository entity ID suggestions', () => {
  it('returns a scoped manual suggestion without reserving its serial', async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.includes('existing_identifier'))
          return {
            rows: [
              {
                programme_slug: 'judicial',
                entity_payload: { name: 'Example' },
                existing_identifier: null,
              },
            ],
          };
        if (sql.includes('WITH used AS'))
          return { rows: [{ next_serial: '8' }] };
        return { rows: [] };
      },
      release: () => undefined,
    };
    const promotion = {
      loadProgrammeNumberingPolicies: async () =>
        new Map([
          [
            'judicial',
            {
              identifier: 'PJE',
              qualifierMode: 'MANUAL',
              serialWidth: 4,
              assignmentMode: 'MANUAL',
            },
          ],
        ]),
    };
    const repository = new GeodataImportMutationRepository(
      { connect: async () => client } as never,
      promotion as never,
    );

    await expect(
      repository.suggestEntityIdentifier(
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        {
          qualifier: 'A Coruña',
        },
      ),
    ).resolves.toEqual({
      entityIdentifier: 'PJE-ACORUNA-0008',
      serial: 8,
      paddedSerial: '0008',
      qualifier: 'ACORUNA',
      assigned: false,
      reserved: false,
    });
    expect(queries.some(({ sql }) => sql.includes('WITH used AS'))).toBe(true);
    expect(
      queries.some(({ sql }) =>
        sql.includes("qualifier_scope=$2 OR qualifier_scope=''"),
      ),
    ).toBe(true);
    expect(queries.some(({ sql }) => sql.includes('INSERT INTO'))).toBe(false);
  });
});
