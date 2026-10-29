import {
  allocateProgrammeEntityIdentifier,
  ProgrammeEntityIdentifierError,
  suggestProgrammeEntityIdentifier,
  type ProgrammeEntityNumberingPolicy,
} from './programme-entity-identifier.js';
import type { PoolClient } from 'pg';

describe('suggestProgrammeEntityIdentifier', () => {
  const policy: ProgrammeEntityNumberingPolicy = {
    identifier: 'PJE',
    qualifierMode: 'MANUAL',
    serialWidth: 4,
    assignmentMode: 'MANUAL',
  };

  it('returns the next scoped serial without reserving it', () => {
    expect(
      suggestProgrammeEntityIdentifier(
        policy,
        {},
        { qualifier: 'A Coruña' },
        23,
      ),
    ).toEqual({
      entityIdentifier: 'PJE-ACORUNA-0023',
      serial: 23,
      paddedSerial: '0023',
      qualifier: 'ACORUNA',
    });
  });

  it('derives a normalized qualifier from the configured location field', () => {
    expect(
      suggestProgrammeEntityIdentifier(
        {
          ...policy,
          qualifierMode: 'LOCATION',
          qualifierField: 'provinceCode',
        },
        { location: { provinceCode: 'a-coruna' } },
        undefined,
        1,
      ).entityIdentifier,
    ).toBe('PJE-ACORUNA-0001');
  });

  it('returns an explicit error at serial exhaustion', () => {
    expect(() =>
      suggestProgrammeEntityIdentifier(policy, {}, { qualifier: 'X' }, 10_000),
    ).toThrow(ProgrammeEntityIdentifierError);
  });
});

describe('allocateProgrammeEntityIdentifier', () => {
  const basePolicy: ProgrammeEntityNumberingPolicy = {
    identifier: 'PJES',
    qualifierMode: 'LOCATION',
    qualifierField: 'provinceCode',
    serialWidth: 3,
    assignmentMode: 'QUALIFIER_SEQUENCE',
  };

  function clientWithNextSerial(nextSerial: number) {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.includes('MAX(serial_number)'))
          return { rows: [{ next_serial: String(nextSerial) }] };
        if (sql.includes('SELECT 1 FROM geodata_entity_identifier_reservation'))
          return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 1 };
      },
    } as unknown as PoolClient;
    return { client, queries };
  }

  it('serializes programme-wide allocation and considers all prior scopes', async () => {
    const fixture = clientWithNextSerial(13);

    await expect(
      allocateProgrammeEntityIdentifier(
        fixture.client,
        'part_jud_es',
        { ...basePolicy, assignmentMode: 'PROGRAMME_SEQUENCE' },
        '11111111-1111-4111-8111-111111111111',
        { location: { provinceCode: 'G' } },
        null,
      ),
    ).resolves.toBe('PJES-G-013');

    expect(fixture.queries[0]?.sql).toContain('pg_advisory_xact_lock');
    expect(fixture.queries[0]?.values).toEqual(['part_jud_es', '']);
    const maximumQuery = fixture.queries.find(({ sql }) =>
      sql.includes('MAX(serial_number)'),
    );
    expect(maximumQuery?.sql).toContain('WHERE programme_slug=$1');
    expect(maximumQuery?.sql).not.toContain('qualifier_scope');
    expect(maximumQuery?.values).toEqual(['part_jud_es']);
    expect(fixture.queries.at(-1)?.values).toEqual([
      'PJES-G-013',
      'part_jud_es',
      '',
      13,
      '11111111-1111-4111-8111-111111111111',
    ]);
  });

  it('serializes qualifier allocation and accounts for prior programme-wide reservations', async () => {
    const fixture = clientWithNextSerial(5);

    await expect(
      allocateProgrammeEntityIdentifier(
        fixture.client,
        'part_jud_es',
        basePolicy,
        '22222222-2222-4222-8222-222222222222',
        { location: { provinceCode: 'G' } },
        null,
      ),
    ).resolves.toBe('PJES-G-005');

    expect(fixture.queries[0]?.values).toEqual(['part_jud_es', 'G']);
    const maximumQuery = fixture.queries.find(({ sql }) =>
      sql.includes('MAX(serial_number)'),
    );
    expect(maximumQuery?.sql).toContain(
      "qualifier_scope=$2 OR qualifier_scope=''",
    );
    expect(maximumQuery?.values).toEqual(['part_jud_es', 'G']);
  });

  it('allows an unused manual serial and checks the complete identifier', async () => {
    const fixture = clientWithNextSerial(1);

    await expect(
      allocateProgrammeEntityIdentifier(
        fixture.client,
        'part_jud_es',
        { ...basePolicy, assignmentMode: 'MANUAL' },
        '33333333-3333-4333-8333-333333333333',
        { location: { provinceCode: 'G' } },
        null,
        { serial: '8' },
      ),
    ).resolves.toBe('PJES-G-008');

    expect(fixture.queries[0]?.sql).toContain('WHERE entity_identifier=$1');
    expect(fixture.queries[0]?.values).toEqual([
      'PJES-G-008',
      'part_jud_es',
      'G',
      8,
    ]);
    expect(fixture.queries.some(({ sql }) => sql.includes('pg_advisory'))).toBe(
      false,
    );
  });

  it('rejects an already reserved manual identifier before insertion', async () => {
    const fixture = clientWithNextSerial(1);
    fixture.client.query = (async (sql: string, values: unknown[] = []) => {
      if (sql.includes('SELECT 1 FROM geodata_entity_identifier_reservation'))
        return { rows: [{ '?column?': 1 }], rowCount: 1 };
      fixture.queries.push({ sql, values });
      return { rows: [], rowCount: 1 };
    }) as typeof fixture.client.query;

    await expect(
      allocateProgrammeEntityIdentifier(
        fixture.client,
        'part_jud_es',
        { ...basePolicy, assignmentMode: 'MANUAL' },
        '55555555-5555-4555-8555-555555555555',
        { location: { provinceCode: 'G' } },
        null,
        { serial: '8' },
      ),
    ).rejects.toThrow('already assigned in this programme scope');
    expect(fixture.queries.some(({ sql }) => sql.includes('INSERT INTO'))).toBe(
      false,
    );
  });

  it('rejects automatic allocation when reservations across scopes exhaust the range', async () => {
    const fixture = clientWithNextSerial(1_000);

    await expect(
      allocateProgrammeEntityIdentifier(
        fixture.client,
        'part_jud_es',
        basePolicy,
        '66666666-6666-4666-8666-666666666666',
        { location: { provinceCode: 'G' } },
        null,
      ),
    ).rejects.toThrow('serial range is exhausted at 999');
    expect(fixture.queries.some(({ sql }) => sql.includes('INSERT INTO'))).toBe(
      false,
    );
  });

  it('turns a concurrent manual reservation into a recoverable retry error', async () => {
    const fixture = clientWithNextSerial(1);
    const query = fixture.client.query.bind(fixture.client);
    fixture.client.query = (async (sql: string, values: unknown[] = []) => {
      if (sql.includes('INSERT INTO geodata_entity_identifier_reservation'))
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      return query(sql, values);
    }) as typeof fixture.client.query;

    await expect(
      allocateProgrammeEntityIdentifier(
        fixture.client,
        'part_jud_es',
        { ...basePolicy, assignmentMode: 'MANUAL' },
        '44444444-4444-4444-8444-444444444444',
        { location: { provinceCode: 'G' } },
        null,
        { serial: '8' },
      ),
    ).rejects.toThrow(
      'assigned concurrently; retry with the latest suggestion',
    );
  });
});
