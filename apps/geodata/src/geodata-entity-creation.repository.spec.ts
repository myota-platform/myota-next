import { BadRequestException } from '@nestjs/common';
import { stringifyJsonWithBigInts } from '../../../libs/platform/src/json-bigint.js';
import type { PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeodataEntityCreationRepository } from './geodata-entity-creation.repository.js';

describe('GeodataEntityCreationRepository', () => {
  const programmeSlug = 'partidos-judiciales';
  const claims = {
    sub: 'admin-1',
    scp: ['*'],
    roles: [],
  } as never;
  const policyResponse = {
    entityTypes: [{ code: 'DISTRICT' }],
    entityNumbering: {
      identifier: 'PJES',
      qualifierMode: 'MANUAL',
      serialWidth: 3,
      assignmentMode: 'MANUAL',
    },
  };

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

  function fixture(geometryError?: Error & { code?: string }) {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const events: Array<{ type: string; payload: Record<string, unknown> }> =
      [];
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.includes('ST_GeomFromGeoJSON') && geometryError)
          throw geometryError;
        if (sql.includes('ST_GeomFromGeoJSON'))
          return { rows: [{ valid: true, empty: false }], rowCount: 1 };
        if (sql.includes('SELECT id::text,code FROM entity_type'))
          return {
            rows: [{ id: 'type-id', code: 'DISTRICT' }],
            rowCount: 1,
          };
        if (sql.includes('SELECT 1 FROM geodata_entity_identifier_reservation'))
          return { rows: [], rowCount: 0 };
        if (sql.includes('SELECT now() AS now'))
          return { rows: [{ now: '2026-10-29T00:00:00.000Z' }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
      release: vi.fn(),
    };
    const support = {
      connect: vi.fn(async () => client as unknown as PoolClient),
      writeEntityEvent: vi.fn(
        async (
          _client: PoolClient,
          _id: string,
          type: string,
          payload: Record<string, unknown>,
        ) => events.push({ type, payload }),
      ),
      readEntityWithClient: vi.fn(async (_client: PoolClient, id: string) => ({
        id,
        entityIdentifier: 'PJES-G-007',
      })),
    };
    return {
      repository: new GeodataEntityCreationRepository(support as never),
      queries,
      events,
      client,
      support,
    };
  }

  const request = {
    name: 'District example',
    programmeSlug,
    entityTypeCodes: ['DISTRICT'],
    geometry: { type: 'Point', coordinates: [-3.7, 40.4] },
    qualifier: 'G',
    serial: '7',
  };

  it('previews a manual identifier without reserving it', async () => {
    const test = fixture();

    const preview = await test.repository.previewIdentifier(
      {
        programmeSlug,
        entityTypeCode: 'DISTRICT',
        qualifier: 'G',
      },
      claims,
    );

    expect(preview).toMatchObject({
      entityIdentifier: 'PJES-G-001',
      serial: 1,
      assignmentMode: 'MANUAL',
      reserved: false,
    });
    expect(
      test.queries.some((query) =>
        query.sql.includes('INSERT INTO geodata_entity_identifier_reservation'),
      ),
    ).toBe(false);
  });

  it('creates one candidate synchronously with an atomic manual ID reservation', async () => {
    const test = fixture();

    const entity = await test.repository.create(undefined, request, claims);

    expect(entity).toEqual({
      id: expect.any(String),
      entityIdentifier: 'PJES-G-007',
    });
    expect(test.queries[0]?.sql).toBe('BEGIN');
    expect(
      test.queries.some((query) =>
        query.sql.includes('INSERT INTO geodata_entity_identifier_reservation'),
      ),
    ).toBe(true);
    expect(
      test.queries.some((query) =>
        query.sql.includes('INSERT INTO geodata_entity'),
      ),
    ).toBe(true);
    const sourceReference = test.queries.find((query) =>
      query.sql.includes('INSERT INTO source_reference'),
    );
    expect(sourceReference?.sql).toContain(
      "VALUES ($1,$2,'MANUAL',$3,$4::jsonb)",
    );
    expect(sourceReference?.values.slice(1, 3)).toEqual([entity.id, entity.id]);
    expect(test.queries.at(-1)?.sql).toBe('COMMIT');
    expect(test.events.map(({ type }) => type)).toEqual([
      'geodata.entity.location-enrichment-requested.v1',
      'geodata.entity.manual-created.v1',
    ]);
    expect(test.events[1]?.payload).toMatchObject({
      entityIdentifier: 'PJES-G-007',
      programmeSlug,
      source: 'MANUAL',
    });
  });

  it('returns a client error for malformed GeoJSON and rolls back', async () => {
    const parseError = Object.assign(new Error('bad geojson'), {
      code: '22P02',
    });
    const test = fixture(parseError);

    await expect(
      test.repository.create(undefined, request, claims),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(test.queries.at(-1)?.sql).toBe('ROLLBACK');
    expect(test.events).toEqual([]);
  });
});
