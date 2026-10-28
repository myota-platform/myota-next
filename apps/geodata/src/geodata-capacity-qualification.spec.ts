import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import type { AccessTokenClaims } from '../../../libs/platform/src/access-token.js';
import { stringifyJsonWithBigInts } from '../../../libs/platform/src/json-bigint.js';
import { GeodataEntityMetadataRepository } from './geodata-entity-metadata.repository.js';
import { GeodataEntityMutationSupport } from './geodata-entity-mutation-support.js';
import { GeodataEntityReviewRepository } from './geodata-entity-review.repository.js';
import { GeodataImportMutationRepository } from './geodata-import-mutation.repository.js';
import { GeodataPromotionRepository } from '../../geodata-worker/src/geodata-promotion.repository.js';

const enabled = process.env.MYOTA_GEODATA_CAPACITY_QUALIFICATION === '1';
const databasePoolMaximum = 10;
const entityTypeCode = `CAPACITY_${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;
const batchSizes = [1, 10, 50, 100, 259, 300];

describe('Geodata synchronous mutation capacity qualification', () => {
  it.skipIf(!enabled)(
    'measures bounded candidate validation, promotion, edits, and approvals',
    async () => {
      const databaseUrl = process.env.GEO_DATABASE_URL;
      if (!databaseUrl)
        throw new Error(
          'Geodata capacity qualification requires GEO_DATABASE_URL',
        );
      assertLocalGeodataDatabase(databaseUrl);
      const resourceLimits = await readCgroupLimits();
      if (process.env.MYOTA_GEODATA_CAPACITY_ENFORCE_LIMITS === '1') {
        if (
          resourceLimits.cpuLimitCores === null ||
          resourceLimits.cpuLimitCores > 1 ||
          resourceLimits.memoryLimitBytes === null ||
          resourceLimits.memoryLimitBytes > 1024 ** 3
        ) {
          throw new Error(
            'Geodata capacity qualification requires a cgroup CPU limit of 1 core and memory limit of 1 GiB',
          );
        }
      }

      const pool = new Pool({
        connectionString: databaseUrl,
        max: databasePoolMaximum,
        application_name: 'myota-geodata-capacity-qualification',
      });
      const mutationSupport = new GeodataEntityMutationSupport(pool);
      const promotion = new GeodataPromotionRepository(pool);
      const importMutations = new GeodataImportMutationRepository(
        pool,
        promotion,
      );
      const metadata = new GeodataEntityMetadataRepository(mutationSupport);
      const review = new GeodataEntityReviewRepository(mutationSupport);
      const runIds = batchSizes.map(() => randomUUID());
      const candidateSets = batchSizes.map((size) =>
        Array.from({ length: size }, () => randomUUID()),
      );
      const runStartedAt = new Date();
      const claims = {
        sub: 'geodata-capacity-reviewer',
        scp: ['*'],
        roles: [{ role: 'GLOBAL_OPERATOR' }],
      } as AccessTokenClaims;
      const batchMeasurements: Array<Record<string, unknown>> = [];
      let maxActiveConnections = 0;
      const sampler = setInterval(() => {
        void pool
          .query<{ count: string }>(
            `SELECT count(*)::text AS count FROM pg_stat_activity
             WHERE datname=current_database() AND state='active'`,
          )
          .then((result) => {
            maxActiveConnections = Math.max(
              maxActiveConnections,
              Number(result.rows[0]?.count ?? 0),
            );
          })
          .catch(() => undefined);
      }, 25);
      const rssBeforeBytes = process.resourceUsage().maxRSS * 1024;

      try {
        await seedCandidates(pool, runIds, candidateSets, batchSizes);
        for (let index = 0; index < batchSizes.length; index++) {
          const size = batchSizes[index]!;
          const runId = runIds[index]!;
          const candidateIds = candidateSets[index]!;
          const validationStarted = performance.now();
          const validation = await importMutations.validateImportCandidates(
            runId,
            undefined,
            { candidateIds, reviewerId: 'geodata-capacity-reviewer' },
          );
          const validationMilliseconds = performance.now() - validationStarted;
          expect(validation.candidateIds).toHaveLength(size);

          const promotionStarted = performance.now();
          const promoted = await importMutations.processImportCandidates(
            runId,
            undefined,
            {
              candidateIds,
              targetStatus: index === 0 ? 'CANDIDATE' : 'APPROVED',
              processorId: 'geodata-capacity-reviewer',
              note: 'Capacity qualification fixture',
            },
            claims,
          );
          const promotionMilliseconds = performance.now() - promotionStarted;
          expect(promoted.status).toBe('COMPLETED');
          expect(promoted.created).toHaveLength(size);
          batchMeasurements.push({
            selectionSize: size,
            validationMilliseconds: roundMilliseconds(validationMilliseconds),
            promotionAndApprovalMilliseconds: roundMilliseconds(
              promotionMilliseconds,
            ),
          });

          if (index === 0) {
            const entityId = String(promoted.created[0]);
            const editStarted = performance.now();
            await metadata.patchEntityMetadata(
              entityId,
              undefined,
              undefined,
              {
                editorId: 'geodata-capacity-editor',
                name: 'Capacity qualification edited entity',
                note: 'Measure a synchronous single-entity edit',
              },
              claims,
            );
            const editMilliseconds = performance.now() - editStarted;
            const approvalStarted = performance.now();
            const approved = await review.reviewEntity(
              entityId,
              undefined,
              undefined,
              {
                reviewerId: 'geodata-capacity-reviewer',
                status: 'APPROVED',
                note: 'Measure a synchronous single-entity approval',
              },
              claims,
            );
            const approvalMilliseconds = performance.now() - approvalStarted;
            expect(approved.status).toBe('APPROVED');
            batchMeasurements.push({
              selectionSize: 1,
              editMilliseconds: roundMilliseconds(editMilliseconds),
              singleEntityApprovalMilliseconds:
                roundMilliseconds(approvalMilliseconds),
            });
          }
        }
      } finally {
        clearInterval(sampler);
        try {
          await removeFixtures(pool, runIds, runStartedAt);
        } finally {
          await pool.end();
        }
      }

      console.info(
        stringifyJsonWithBigInts({
          qualification: 'geodata-synchronous-capacity',
          measuredAt: new Date().toISOString(),
          environment: {
            node: process.version,
            ...resourceLimits,
            enforcedCpuLimitCores: 1,
            enforcedMemoryLimitBytes: 1024 ** 3,
            databasePoolMaximum,
            geodataApiReplicas: 2,
            geodataWorkerReplicas: 1,
          },
          selectionMeasurements: batchMeasurements,
          database: { peakActiveConnections: maxActiveConnections },
          peakProcessRssGrowthBytes: Math.max(
            0,
            process.resourceUsage().maxRSS * 1024 - rssBeforeBytes,
          ),
        }),
      );
    },
    10 * 60 * 1000,
  );
});

async function seedCandidates(
  pool: Pool,
  runIds: string[],
  candidateSets: string[][],
  sizes: number[],
) {
  const client = await pool.connect();
  let ordinal = 0;
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('myota.geodata_writer','row-v1',true)",
    );
    for (let index = 0; index < sizes.length; index++) {
      const runId = runIds[index]!;
      await client.query(
        `INSERT INTO import_run(id,adapter_code,source_metadata,status)
         VALUES ($1,'MANUAL',$2::jsonb,'COMPLETED')`,
        [
          runId,
          stringifyJsonWithBigInts({
            programmeSlug: `capacity-${runId}`,
            source: { name: 'capacity-qualification', sourceKey: runId },
          }),
        ],
      );
      for (const candidateId of candidateSets[index]!) {
        const longitude = -5 + ordinal * 0.01;
        const properties = {
          jurisdiction: 'ES-AN',
          geometry: {
            type: 'Point',
            coordinates: [longitude, 37.4],
          },
          candidateSource: { name: 'capacity-qualification' },
        };
        await client.query(
          `INSERT INTO geodata_import_candidate
           (id,import_run_id,ordinal,programme_slug,entity_type_codes,name,geom,
            candidate_source,source_ref,source_hash,entity_payload)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,
             ST_SetSRID(ST_GeomFromText($7),4326),$8::jsonb,$9,$10,$11::jsonb)`,
          [
            candidateId,
            runId,
            ordinal + 1,
            `capacity-${runId}`,
            stringifyJsonWithBigInts([entityTypeCode]),
            `Capacity fixture ${ordinal + 1}`,
            `POINT(${longitude} 37.4)`,
            stringifyJsonWithBigInts({ sourceKey: runId }),
            `${runId}:${ordinal}`,
            `${ordinal}`.padStart(64, '0'),
            stringifyJsonWithBigInts(properties),
          ],
        );
        ordinal++;
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function removeFixtures(pool: Pool, runIds: string[], startedAt: Date) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('myota.geodata_writer','row-v1',true)",
    );
    await client.query(
      `DELETE FROM conflation_candidate
       WHERE left_entity_id IN (
         SELECT id FROM geodata_entity
         WHERE public_properties#>>'{provenance,importRunId}'=ANY($1::text[])
       ) OR right_entity_id IN (
         SELECT id FROM geodata_entity
         WHERE public_properties#>>'{provenance,importRunId}'=ANY($1::text[])
       )`,
      [runIds],
    );
    await client.query(
      `DELETE FROM source_reference
       WHERE adapter_code='MANUAL' AND source_record_id LIKE ANY($1::text[])`,
      [runIds.map((runId) => `${runId}:%`)],
    );
    await client.query(
      `DELETE FROM geodata_audit_event WHERE aggregate_id IN (
         SELECT id::text FROM geodata_entity
         WHERE public_properties#>>'{provenance,importRunId}'=ANY($1::text[])
       )`,
      [runIds],
    );
    const fixtureEvents = `SELECT event_id FROM outbox_event
      WHERE occurred_at >= $1 AND (
         aggregate_id=ANY($2::text[]) OR aggregate_id IN (
           SELECT id::text FROM geodata_entity
           WHERE public_properties#>>'{provenance,importRunId}'=ANY($2::text[])
         ) OR payload->>'importRunId'=ANY($2::text[])
       )`;
    await client.query(
      `DELETE FROM outbox_redrive_audit WHERE event_id IN (${fixtureEvents})`,
      [startedAt, runIds],
    );
    await client.query(
      `DELETE FROM dead_letter_event WHERE event_id IN (${fixtureEvents})`,
      [startedAt, runIds],
    );
    await client.query(
      `DELETE FROM outbox_event WHERE event_id IN (${fixtureEvents})`,
      [startedAt, runIds],
    );
    await client.query(
      `DELETE FROM entity_review WHERE entity_id IN (
         SELECT id FROM geodata_entity
         WHERE public_properties#>>'{provenance,importRunId}'=ANY($1::text[])
       )`,
      [runIds],
    );
    await client.query(
      `DELETE FROM geodata_entity WHERE public_properties#>>'{provenance,importRunId}'=ANY($1::text[])`,
      [runIds],
    );
    await client.query('DELETE FROM import_run WHERE id=ANY($1::uuid[])', [
      runIds,
    ]);
    await client.query(
      `DELETE FROM entity_type t WHERE t.programme_id IS NULL AND t.code=$1
       AND NOT EXISTS (SELECT 1 FROM geodata_entity_category c WHERE c.category_id=t.id)
       AND NOT EXISTS (SELECT 1 FROM geodata_entity e WHERE e.entity_type_id=t.id)`,
      [entityTypeCode],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function assertLocalGeodataDatabase(connectionString: string) {
  const url = new URL(connectionString);
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    decodeURIComponent(url.pathname.slice(1)) !== 'myota_geo'
  ) {
    throw new Error(
      'Geodata capacity qualification only runs against loopback myota_geo',
    );
  }
}

async function readCgroupLimits() {
  try {
    const [cpu, memory] = await Promise.all([
      readFile('/sys/fs/cgroup/cpu.max', 'utf8'),
      readFile('/sys/fs/cgroup/memory.max', 'utf8'),
    ]);
    const [quota, period] = cpu.trim().split(/\s+/);
    const cpuLimitCores =
      quota === 'max' || !quota || !period
        ? null
        : Number(quota) / Number(period);
    const memoryLimitBytes =
      memory.trim() === 'max' ? null : Number(memory.trim());
    return {
      cpuLimitCores:
        cpuLimitCores !== null && Number.isFinite(cpuLimitCores)
          ? cpuLimitCores
          : null,
      memoryLimitBytes:
        memoryLimitBytes !== null && Number.isFinite(memoryLimitBytes)
          ? memoryLimitBytes
          : null,
    };
  } catch {
    return { cpuLimitCores: null, memoryLimitBytes: null };
  }
}

function roundMilliseconds(value: number) {
  return Math.round(value * 100) / 100;
}
