import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  allocateProgrammeEntityIdentifier,
  findNextFreeProgrammeEntitySerial,
  type ProgrammeEntityNumberingPolicy,
} from './programme-entity-identifier.js';

const databaseUrl = process.env.GEO_DATABASE_URL;

describe.skipIf(!databaseUrl)(
  'programme entity identifier database allocation',
  () => {
    const pool = databaseUrl
      ? new Pool({ connectionString: databaseUrl, max: 6 })
      : undefined;
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase();
    const prefixes = [
      `A${suffix.slice(0, 3)}`,
      `B${suffix.slice(3, 6)}`,
      `C${suffix.slice(6, 9)}`,
      `D${suffix.slice(9, 12)}`,
      `E${suffix.slice(12, 15)}`,
    ];
    const programmeSlugs = [
      `id-sequence-${suffix}`,
      `id-qualifier-${suffix}`,
      `id-transition-${suffix}`,
      `id-manual-race-${suffix}`,
      `id-manual-gap-${suffix}`,
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
      // Reservations are intentionally append-only and permanent. Each run
      // uses a random programme suffix so its committed reservation fixtures
      // can never collide with another run.
      await pool.end();
    });

    it('keeps entity identifiers write-once and reservations permanent', async () => {
      if (!pool) throw new Error('GEO_DATABASE_URL is required');
      const client = await pool.connect();
      const entityId = randomUUID();
      const identifier = `${prefixes[0]}-001`;
      try {
        await client.query('BEGIN');
        await client.query(
          "SELECT set_config('myota.geodata_writer','row-v1',true)",
        );
        await client.query(
          `INSERT INTO geodata_entity_identifier_reservation
             (entity_identifier,programme_slug,qualifier_scope,serial_number,entity_id)
           VALUES ($1,$2,'',1,$3)`,
          [identifier, programmeSlugs[0], entityId],
        );
        await client.query(
          `INSERT INTO geodata_entity(id,name,geom,programme_slug)
           VALUES ($1,'Identifier immutability fixture',
                   ST_SetSRID(ST_GeomFromText('POINT(0 0)'),4326),$2)`,
          [entityId, programmeSlugs[0]],
        );
        await client.query(
          'UPDATE geodata_entity SET entity_identifier=$2 WHERE id=$1',
          [entityId, identifier],
        );

        await expectRejectedAndRecover(client, 'clear_identifier', () =>
          client.query(
            'UPDATE geodata_entity SET entity_identifier=NULL WHERE id=$1',
            [entityId],
          ),
        );
        await expectRejectedAndRecover(client, 'change_identifier', () =>
          client.query(
            'UPDATE geodata_entity SET entity_identifier=$2 WHERE id=$1',
            [entityId, `${prefixes[0]}-002`],
          ),
        );
        await expectRejectedAndRecover(client, 'move_programme', () =>
          client.query(
            'UPDATE geodata_entity SET programme_slug=$2 WHERE id=$1',
            [entityId, `${programmeSlugs[0]}-other`],
          ),
        );
        await expectRejectedAndRecover(client, 'update_reservation', () =>
          client.query(
            `UPDATE geodata_entity_identifier_reservation
                SET serial_number=2 WHERE entity_identifier=$1`,
            [identifier],
          ),
        );
        await expectRejectedAndRecover(client, 'delete_reservation', () =>
          client.query(
            'DELETE FROM geodata_entity_identifier_reservation WHERE entity_identifier=$1',
            [identifier],
          ),
        );
        await client.query('DELETE FROM geodata_entity WHERE id=$1', [
          entityId,
        ]);
        const retainedReservation = await client.query(
          'SELECT entity_id FROM geodata_entity_identifier_reservation WHERE entity_identifier=$1',
          [identifier],
        );
        expect(retainedReservation.rows).toEqual([{ entity_id: entityId }]);
        await expectRejectedAndRecover(client, 'reuse_deleted_identifier', () =>
          client.query(
            `INSERT INTO geodata_entity(id,name,geom,programme_slug,entity_identifier)
             VALUES ($1,'Reused identifier fixture',
                     ST_SetSRID(ST_GeomFromText('POINT(0 0)'),4326),$2,$3)`,
            [randomUUID(), programmeSlugs[0], identifier],
          ),
        );
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
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

    it('suggests the lowest free serial when reservations contain a gap', async () => {
      if (!pool) throw new Error('GEO_DATABASE_URL is required');
      const policy: ProgrammeEntityNumberingPolicy = {
        identifier: prefixes[4]!,
        qualifierMode: 'LOCATION',
        qualifierField: 'provinceCode',
        serialWidth: 3,
        assignmentMode: 'MANUAL',
      };
      await pool.query(
        `INSERT INTO geodata_entity_identifier_reservation
           (entity_identifier,programme_slug,qualifier_scope,serial_number,entity_id)
         VALUES ($1,$2,'G',1,$3),($4,$2,'G',3,$5)`,
        [
          `${prefixes[4]}-G-001`,
          programmeSlugs[4],
          randomUUID(),
          `${prefixes[4]}-G-003`,
          randomUUID(),
        ],
      );
      const client = await pool.connect();
      try {
        await expect(
          findNextFreeProgrammeEntitySerial(
            client,
            programmeSlugs[4]!,
            policy,
            'G',
          ),
        ).resolves.toBe(2);
      } finally {
        client.release();
      }
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

    async function expectRejectedAndRecover(
      client: PoolClient,
      savepoint: string,
      operation: () => Promise<unknown>,
    ): Promise<void> {
      await client.query(`SAVEPOINT ${savepoint}`);
      await expect(operation()).rejects.toMatchObject({ code: '23514' });
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
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
