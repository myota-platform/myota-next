import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  allocateProgrammeEntityIdentifier,
  type ProgrammeEntityNumberingPolicy,
} from './programme-entity-identifier.js';

const databaseUrl = process.env.GEO_DATABASE_URL;

describe.skipIf(!databaseUrl)(
  'programme entity identifier database allocation',
  () => {
    const pool = databaseUrl
      ? new Pool({ connectionString: databaseUrl, max: 6 })
      : undefined;
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const prefixes = [
      `A${suffix.slice(0, 3)}`,
      `B${suffix.slice(3, 6)}`,
      `C${suffix.slice(6, 9)}`,
      `D${suffix.slice(9, 12)}`,
    ];
    const programmeSlugs = [
      `id-sequence-${suffix}`,
      `id-qualifier-${suffix}`,
      `id-transition-${suffix}`,
      `id-manual-race-${suffix}`,
    ];

    beforeAll(() => {
      if (
        !databaseUrl ||
        !['localhost', '127.0.0.1', '[::1]'].includes(
          new URL(databaseUrl).hostname,
        )
      )
        throw new Error(
          'programme entity identifier database tests require local Postgres',
        );
    });

    afterAll(async () => {
      if (!pool) return;
      try {
        await pool.query(
          'DELETE FROM geodata_entity_identifier_reservation WHERE programme_slug=ANY($1::text[])',
          [programmeSlugs],
        );
      } finally {
        await pool.end();
      }
    });

    it('allocates concurrent programme and qualifier sequences without duplicates', async () => {
      const sequencePolicy: ProgrammeEntityNumberingPolicy = {
        identifier: prefixes[0]!,
        qualifierMode: 'LOCATION',
        qualifierField: 'provinceCode',
        serialWidth: 3,
        assignmentMode: 'PROGRAMME_SEQUENCE',
      };
      const qualifierPolicy = {
        ...sequencePolicy,
        assignmentMode: 'QUALIFIER_SEQUENCE' as const,
      };

      const programmeIds = await Promise.all([
        allocateCommitted(programmeSlugs[0]!, sequencePolicy, {
          location: { provinceCode: 'G' },
        }),
        allocateCommitted(programmeSlugs[0]!, sequencePolicy, {
          location: { provinceCode: 'G' },
        }),
      ]);
      expect(
        programmeIds.sort((left, right) => left.localeCompare(right)),
      ).toEqual([`${prefixes[0]}-G-001`, `${prefixes[0]}-G-002`]);

      const scopedPolicy = { ...qualifierPolicy, identifier: prefixes[1]! };
      const qualifierIds = await Promise.all([
        allocateCommitted(programmeSlugs[1]!, scopedPolicy, {
          location: { provinceCode: 'G' },
        }),
        allocateCommitted(programmeSlugs[1]!, scopedPolicy, {
          location: { provinceCode: 'G' },
        }),
        allocateCommitted(programmeSlugs[1]!, scopedPolicy, {
          location: { provinceCode: 'H' },
        }),
      ]);
      expect(
        qualifierIds.sort((left, right) => left.localeCompare(right)),
      ).toEqual([
        `${prefixes[1]}-G-001`,
        `${prefixes[1]}-G-002`,
        `${prefixes[1]}-H-001`,
      ]);
    });

    it('carries serial history across numbering policy changes', async () => {
      const sequencePolicy: ProgrammeEntityNumberingPolicy = {
        identifier: prefixes[2]!,
        qualifierMode: 'LOCATION',
        qualifierField: 'provinceCode',
        serialWidth: 3,
        assignmentMode: 'PROGRAMME_SEQUENCE',
      };
      const qualifierPolicy = {
        ...sequencePolicy,
        assignmentMode: 'QUALIFIER_SEQUENCE' as const,
      };

      await expect(
        allocateCommitted(programmeSlugs[2]!, sequencePolicy, {
          location: { provinceCode: 'G' },
        }),
      ).resolves.toBe(`${prefixes[2]}-G-001`);
      await expect(
        allocateCommitted(programmeSlugs[2]!, qualifierPolicy, {
          location: { provinceCode: 'G' },
        }),
      ).resolves.toBe(`${prefixes[2]}-G-002`);
      await expect(
        allocateCommitted(programmeSlugs[2]!, sequencePolicy, {
          location: { provinceCode: 'H' },
        }),
      ).resolves.toBe(`${prefixes[2]}-H-003`);
    });

    it('allows only one concurrent manual reservation for a suggested identifier', async () => {
      if (!pool) throw new Error('GEO_DATABASE_URL is required');
      const policy: ProgrammeEntityNumberingPolicy = {
        identifier: prefixes[3]!,
        qualifierMode: 'LOCATION',
        qualifierField: 'provinceCode',
        serialWidth: 3,
        assignmentMode: 'MANUAL',
      };
      const bothManualReads = barrier(2);
      const assignments = await Promise.allSettled(
        [1, 2].map(async () => {
          const client = await pool.connect();
          await client.query('BEGIN');
          try {
            await client.query(
              "SELECT set_config('myota.geodata_writer','row-v1',true)",
            );
            const identifier = await allocateProgrammeEntityIdentifier(
              manualReadBarrier(client, bothManualReads.arrive),
              programmeSlugs[3]!,
              policy,
              randomUUID(),
              { location: { provinceCode: 'G' } },
              null,
              { serial: '7' },
            );
            await client.query('COMMIT');
            return identifier;
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }
        }),
      );

      expect(
        assignments.filter((item) => item.status === 'fulfilled'),
      ).toHaveLength(1);
      const rejected = assignments.find((item) => item.status === 'rejected');
      expect(rejected?.status).toBe('rejected');
      if (rejected?.status === 'rejected')
        expect(String(rejected.reason)).toContain(
          'assigned concurrently; retry with the latest suggestion',
        );
      expect(
        assignments
          .filter(
            (item): item is PromiseFulfilledResult<string> =>
              item.status === 'fulfilled',
          )
          .map((item) => item.value),
      ).toEqual([`${prefixes[3]}-G-007`]);
    });

    async function allocateCommitted(
      programmeSlug: string,
      policy: ProgrammeEntityNumberingPolicy,
      properties: Record<string, unknown>,
    ): Promise<string | null> {
      if (!pool) throw new Error('GEO_DATABASE_URL is required');
      const client = await pool.connect();
      await client.query('BEGIN');
      try {
        await client.query(
          "SELECT set_config('myota.geodata_writer','row-v1',true)",
        );
        const identifier = await allocateProgrammeEntityIdentifier(
          client,
          programmeSlug,
          policy,
          randomUUID(),
          properties,
          null,
        );
        await client.query('COMMIT');
        return identifier;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  },
);

function barrier(parties: number): { arrive: () => Promise<void> } {
  let arrivals = 0;
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    arrive: async () => {
      arrivals += 1;
      if (arrivals === parties) release();
      await wait;
    },
  };
}

function manualReadBarrier(
  client: PoolClient,
  arrive: () => Promise<void>,
): PoolClient {
  const query = client.query.bind(client);
  return {
    query: async (sql: string, values?: unknown[]) => {
      const result = await query(sql, values);
      if (sql.includes('SELECT 1 FROM geodata_entity_identifier_reservation'))
        await arrive();
      return result;
    },
  } as unknown as PoolClient;
}
