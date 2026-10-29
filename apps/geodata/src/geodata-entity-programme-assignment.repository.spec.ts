import { stringifyJsonWithBigInts } from '../../../libs/platform/src/json-bigint.js';
import type { Pool, PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeodataEntityProgrammeAssignmentRepository } from './geodata-entity-programme-assignment.repository.js';

const programmeSlug = 'partidos-judiciales';
const entityIds = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
];
const policyResponse = {
  entityTypes: [{ code: 'PART_JUD' }],
  entityNumbering: {
    identifier: 'PJES',
    qualifierMode: 'NONE',
    serialWidth: 3,
    assignmentMode: 'PROGRAMME_SEQUENCE',
  },
};

describe('GeodataEntityProgrammeAssignmentRepository', () => {
  beforeEach(() => {
    vi.stubEnv('MYOTA_PROGRAMMES_URL', 'http://programmes:8002');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(stringifyJsonWithBigInts(policyResponse), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  function fixture() {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const events: Array<{ id: string; type: string; payload: unknown }> = [];
    const reservations: Array<{
      entity_identifier: string;
      programme_slug: string;
      qualifier_scope: string;
      serial_number: number;
      entity_id: string;
    }> = [];
    const entities = entityIds.map((id, index) => ({
      id,
      name: `District ${index + 1}`,
      status: 'APPROVED',
      programme_slug: null,
      entity_identifier: null,
      entity_type_codes: ['PART_JUD'],
      jurisdiction: null,
      stable_order_key: `TEST:${index + 1}`,
      public_properties: {},
      location: {},
    }));
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.includes('SELECT e.id::text AS id'))
          return { rows: entities, rowCount: entities.length };
        if (sql.includes('SELECT qualifier_scope,serial_number'))
          return {
            rows: reservations.map(({ qualifier_scope, serial_number }) => ({
              qualifier_scope,
              serial_number,
            })),
            rowCount: reservations.length,
          };
        if (
          sql.includes('SELECT COALESCE(MAX(serial_number),0)+1 AS next_serial')
        )
          return {
            rows: [
              {
                next_serial:
                  Math.max(0, ...reservations.map((row) => row.serial_number)) +
                  1,
              },
            ],
            rowCount: 1,
          };
        if (sql.includes('INSERT INTO geodata_entity_identifier_reservation')) {
          reservations.push({
            entity_identifier: String(values[0]),
            programme_slug: String(values[1]),
            qualifier_scope: String(values[2]),
            serial_number: Number(values[3]),
            entity_id: String(values[4]),
          });
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('UPDATE geodata_entity'))
          return { rows: [{ id: values[0] }], rowCount: 1 };
        if (sql.includes('SELECT now() AS occurred_at'))
          return {
            rows: [{ occurred_at: new Date('2026-10-29T00:00:00.000Z') }],
            rowCount: 1,
          };
        return { rows: [], rowCount: 1 };
      },
      release: vi.fn(),
    };
    const support = {
      writeEntityEvent: vi.fn(
        async (
          _client: PoolClient,
          id: string,
          type: string,
          payload: unknown,
        ) => events.push({ id, type, payload }),
      ),
    };
    const pool = {
      connect: vi.fn(async () => client as unknown as PoolClient),
    };
    return {
      repository: new GeodataEntityProgrammeAssignmentRepository(
        pool as unknown as Pool,
        support as never,
      ),
      queries,
      events,
      reservations,
      client,
    };
  }

  const claims = { sub: 'admin-1', scp: ['*'], roles: [] } as never;
  const request = { programmeSlug, entityIds };

  it('previews stable sequential IDs without reserving them', async () => {
    const test = fixture();

    const preview = await test.repository.preview(request, claims);

    expect(preview).toMatchObject({
      programmeSlug,
      assignmentMode: 'PROGRAMME_SEQUENCE',
      entityCount: 2,
      items: [
        { entityId: entityIds[0], entityIdentifier: 'PJES-001', serial: 1 },
        { entityId: entityIds[1], entityIdentifier: 'PJES-002', serial: 2 },
      ],
    });
    expect(test.reservations).toHaveLength(0);
  });

  it('assigns a selected set atomically and publishes an event for each ID', async () => {
    const test = fixture();
    const preview = await test.repository.preview(request, claims);
    test.queries.length = 0;

    const result = await test.repository.assign(
      undefined,
      {
        ...request,
        expectedIdentifiers: preview.items.map((item) => ({
          entityId: item.entityId,
          entityIdentifier: item.entityIdentifier,
        })),
      },
      claims,
    );

    expect(result).toMatchObject({ programmeSlug, assignedCount: 2 });
    expect(test.reservations.map((item) => item.entity_identifier)).toEqual([
      'PJES-001',
      'PJES-002',
    ]);
    expect(test.events).toHaveLength(2);
    expect(test.queries[0]?.sql).toBe('BEGIN');
    expect(test.queries.at(-1)?.sql).toBe('COMMIT');
    expect(
      test.queries.filter((query) =>
        query.sql.includes('UPDATE geodata_entity'),
      ),
    ).toHaveLength(2);
  });
});
