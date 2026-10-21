import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { parsePageTotal } from '@app/platform/pagination.js';
import { pythonRound } from '@app/platform/python-number.js';
import { pythonStrip } from '@app/platform/python-string.js';
import { unicodeCaseFold } from '@app/platform/unicode-casefold.js';
import { utcTimestamp } from '@app/platform/utc-timestamp.js';
import {
  locationSnapshot,
  queueLocationEnrichment,
} from '../../geodata/src/geodata-location-enrichment.js';

interface PromotionQueue {
  id: string;
  import_run_id: string;
  candidate_ids: string[];
  target_status: 'CANDIDATE' | 'APPROVED';
  requested_by: string;
  job_metadata: Record<string, unknown>;
  attempt_count: number;
}

@Injectable()
export class GeodataPromotionRepository {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async claimPromotion(queueId?: string): Promise<PromotionQueue | null> {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT q.id,q.import_run_id,q.candidate_ids,q.target_status,q.requested_by,q.job_metadata,q.attempt_count
         FROM geodata_import_processing_queue q
         JOIN import_run candidate_run ON candidate_run.id=q.import_run_id
         WHERE ($1::uuid IS NULL OR q.id=$1)
           AND (q.status='QUEUED' OR (q.status='PROCESSING' AND q.lease_until < now()))
           AND NOT EXISTS (
             SELECT 1 FROM geodata_import_processing_queue active
             JOIN import_run active_run ON active_run.id=active.import_run_id
             WHERE active.status='PROCESSING'
               AND (active.requested_at,active.id)<(q.requested_at,q.id)
               AND active_run.adapter_code=candidate_run.adapter_code
               AND COALESCE(
                 NULLIF(active_run.source_metadata->'source'->>'sourceKey',''),
                 NULLIF(active_run.source_metadata->'source'->>'url',''),
                 NULLIF(active_run.source_metadata->'source'->>'name',''),
                 'unknown-source'
               )=COALESCE(
                 NULLIF(candidate_run.source_metadata->'source'->>'sourceKey',''),
                 NULLIF(candidate_run.source_metadata->'source'->>'url',''),
                 NULLIF(candidate_run.source_metadata->'source'->>'name',''),
                 'unknown-source'
               )
           )
         ORDER BY q.requested_at,q.id FOR UPDATE OF q SKIP LOCKED LIMIT 1`,
        [queueId ?? null],
      );
      const row = result.rows[0] as PromotionQueue | undefined;
      if (!row) {
        await client.query('COMMIT');
        return null;
      }
      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await client.query(
        `UPDATE geodata_import_processing_queue SET status='PROCESSING',
         attempt_count=attempt_count+1,heartbeat_at=now(),lease_until=now()+interval '5 minutes',
         started_at=COALESCE(started_at,now()),error=NULL WHERE id=$1`,
        [row.id],
      );
      await client.query('COMMIT');
      return {
        ...row,
        candidate_ids: Array.isArray(row.candidate_ids)
          ? row.candidate_ids
          : JSON.parse(String(row.candidate_ids)),
        attempt_count: Number(row.attempt_count) + 1,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getPromotionState(queueId: string): Promise<{
    status: string;
    leaseRemainingSeconds: number;
  } | null> {
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT status,GREATEST(0,EXTRACT(EPOCH FROM (lease_until-now()))) AS lease_remaining
         FROM geodata_import_processing_queue WHERE id=$1`,
        [queueId],
      );
      const row = result.rows[0];
      return row
        ? {
            status: row.status,
            leaseRemainingSeconds: Number(row.lease_remaining ?? 0),
          }
        : null;
    } finally {
      client.release();
    }
  }

  async processPromotion(queue: PromotionQueue) {
    const created: string[] = [];
    const updated: string[] = [];
    const errors: Record<string, string>[] = [];
    for (let index = 0; index < queue.candidate_ids.length; index++) {
      if (index > 0 && index % 25 === 0) await this.heartbeatPromotion(queue);
      const candidateId = queue.candidate_ids[index];
      try {
        const outcome = await this.promoteCandidate(queue, candidateId);
        (outcome.updated ? updated : created).push(outcome.entityId);
      } catch (error) {
        if (isCandidateConflict(error)) {
          errors.push({ candidateId, message: errorMessage(error) });
          continue;
        }
        throw error;
      }
    }
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT status,attempt_count FROM geodata_import_processing_queue WHERE id=$1 FOR UPDATE`,
        [queue.id],
      );
      if (
        locked.rows[0]?.status !== 'PROCESSING' ||
        Number(locked.rows[0]?.attempt_count) !== queue.attempt_count
      )
        throw new Error('geodata promotion lease was superseded');
      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      const result = { created, updated, errors };
      const status = errors.length ? 'FAILED' : 'COMPLETED';
      await client.query(
        `UPDATE geodata_import_processing_queue SET status=$2,result=$3::jsonb,
         completed_at=now(),heartbeat_at=now(),lease_until=NULL,error=NULL WHERE id=$1`,
        [queue.id, status, stringifyJsonWithBigInts(result)],
      );
      const totals = await client.query(
        `SELECT count(*) FILTER (WHERE validation_status='PROCESSED' AND existing_entity_id IS NULL) AS created,
          count(*) FILTER (WHERE validation_status='PROCESSED' AND existing_entity_id IS NOT NULL) AS updated,
          count(*) FILTER (WHERE validation_status<>'PROCESSED') AS remaining
         FROM geodata_import_candidate WHERE import_run_id=$1`,
        [queue.import_run_id],
      );
      const counts = totals.rows[0];
      const createdCount = parsePageTotal(counts.created);
      const updatedCount = parsePageTotal(counts.updated);
      const remainingCount = parsePageTotal(counts.remaining);
      const importRun = await client.query(
        `SELECT status,complete_snapshot,adapter_code,source_hash,
          disappearance_policy,source_metadata
         FROM import_run WHERE id=$1 FOR UPDATE`,
        [queue.import_run_id],
      );
      const run = importRun.rows[0] as
        | {
            status: string;
            complete_snapshot: boolean;
            adapter_code: string;
            source_hash: string;
            disappearance_policy: string;
            source_metadata: Record<string, unknown>;
          }
        | undefined;
      let disappeared = 0;
      if (
        run?.complete_snapshot &&
        run.status === 'PREPROCESSED' &&
        BigInt(remainingCount) === 0n &&
        errors.length === 0 &&
        !run.source_metadata.snapshotReconciledAt
      )
        disappeared = await this.reconcileSnapshot(
          client,
          queue.import_run_id,
          run,
        );
      await client.query(
        `UPDATE import_run SET stats=stats || $2::jsonb,
         status=CASE WHEN $3::bigint=0 AND $4=0 THEN 'COMPLETED' ELSE status END,
         completed_at=CASE WHEN $3::bigint=0 AND $4=0 THEN now() ELSE completed_at END
         WHERE id=$1`,
        [
          queue.import_run_id,
          stringifyJsonWithBigInts({
            created: createdCount,
            updated: updatedCount,
            processed: parsePageTotal(
              BigInt(createdCount) + BigInt(updatedCount),
            ),
            processingErrors: errors.length,
            disappeared,
          }),
          remainingCount,
          errors.length,
        ],
      );
      const eventPayload = {
        queueId: queue.id,
        importRunId: queue.import_run_id,
        status,
        targetStatus: queue.target_status,
        created,
        updated,
        errors,
      };
      await this.writeFact(
        client,
        'geodata.import.processing.completed.v1',
        'import_processing_queue',
        queue.id,
        eventPayload,
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async reconcileSnapshot(
    client: PoolClient,
    runId: string,
    run: {
      adapter_code: string;
      source_hash: string;
      disappearance_policy: string;
      source_metadata: Record<string, unknown>;
    },
  ) {
    const metadata = run.source_metadata;
    const requestedPolicy = Object.hasOwn(metadata, 'disappearancePolicy')
      ? metadata.disappearancePolicy
      : run.disappearance_policy;
    if (
      typeof requestedPolicy !== 'string' ||
      !['UNCHANGED', 'STALE', 'RETIRED', 'REVIEW_REQUIRED'].includes(
        requestedPolicy,
      )
    )
      throw new Error(
        'disappearancePolicy must be UNCHANGED, STALE, RETIRED, or REVIEW_REQUIRED',
      );
    const source = isRecord(metadata.source) ? metadata.source : {};
    const sourceKey =
      textValue(source.sourceKey ?? source.url ?? source.name) ??
      'unknown-source';
    const programmeSlug = textValue(metadata.programmeSlug);
    const savedManifest = await client.query(
      `SELECT id::text FROM source_snapshot_manifest
       WHERE import_run_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`,
      [runId],
    );
    const manifestId = savedManifest.rows[0]
      ? String(savedManifest.rows[0].id)
      : randomUUID();
    if (!savedManifest.rows[0])
      await client.query(
        `INSERT INTO source_snapshot_manifest
          (id,import_run_id,source_key,adapter_code,source_hash,record_count,source_metadata,retrieved_at)
         SELECT $1,$2,$3,$4,$5,count(*),$6::jsonb,now()
         FROM geodata_import_candidate WHERE import_run_id=$2`,
        [
          manifestId,
          runId,
          sourceKey,
          run.adapter_code,
          run.source_hash,
          stringifyJsonWithBigInts(source),
        ],
      );
    await client.query(
      `INSERT INTO source_snapshot_record(manifest_id,source_record_id,record_hash)
       SELECT DISTINCT $1,source_ref,COALESCE(source_hash,'')
       FROM geodata_import_candidate
       WHERE import_run_id=$2 AND source_ref IS NOT NULL
       ON CONFLICT (manifest_id,source_record_id) DO NOTHING`,
      [manifestId, runId],
    );
    let disappeared = 0;
    if (requestedPolicy !== 'UNCHANGED') {
      const missing = await client.query(
        `SELECT e.id::text,e.lifecycle_status,e.public_properties
         FROM geodata_entity e
         WHERE e.programme_slug IS NOT DISTINCT FROM $1
           AND e.source_key=$3 AND e.source_state='CURRENT'
           AND EXISTS (
             SELECT 1 FROM source_reference r
             WHERE r.entity_id=e.id AND r.adapter_code=$2
           )
           AND NOT EXISTS (
             SELECT 1 FROM source_reference r
             JOIN source_snapshot_record sr ON sr.source_record_id=r.source_record_id
             WHERE r.entity_id=e.id AND r.adapter_code=$2 AND sr.manifest_id=$4
           )
         FOR UPDATE OF e`,
        [programmeSlug, run.adapter_code, sourceKey, manifestId],
      );
      for (const row of missing.rows as Array<{
        id: string;
        lifecycle_status: string;
        public_properties: Record<string, unknown>;
      }>) {
        const occurredAt = await utcTimestamp(client);
        const policy = requestedPolicy;
        const sourceState =
          policy === 'STALE'
            ? 'STALE'
            : policy === 'RETIRED'
              ? 'RETIRED'
              : 'REVIEW_REQUIRED';
        const event = {
          action: 'SOURCE_DISAPPEARED',
          policy,
          previousStatus: row.lifecycle_status,
          occurredAt,
        };
        await client.query(
          `UPDATE geodata_entity SET source_state=$2,
           lifecycle_status=CASE WHEN $2='RETIRED' THEN 'RETIRED' ELSE lifecycle_status END,
           public_properties=jsonb_set(
             COALESCE(public_properties,'{}'::jsonb),'{reviewHistory}',
             (CASE WHEN jsonb_typeof(public_properties->'reviewHistory')='array'
               THEN public_properties->'reviewHistory' ELSE '[]'::jsonb END) || jsonb_build_array($3::jsonb),true
           ) || jsonb_build_object('updatedAt',$4::text),
           updated_at=$4,revision=revision+1 WHERE id=$1`,
          [row.id, sourceState, stringifyJsonWithBigInts(event), occurredAt],
        );
        await this.writeFact(
          client,
          'geodata.entity.source-disappeared.v1',
          'entity',
          row.id,
          {
            entityId: row.id,
            policy,
            previousStatus: row.lifecycle_status,
          },
          occurredAt,
        );
        disappeared += 1;
      }
    }
    const reconciledAt = await utcTimestamp(client);
    await client.query(
      `UPDATE import_run SET source_metadata=source_metadata || jsonb_build_object(
        'snapshotReconciledAt',$2::text,'sourceSnapshotManifestId',$3::text
       ) WHERE id=$1`,
      [runId, reconciledAt, manifestId],
    );
    return disappeared;
  }

  private async createConflationCandidates(
    client: PoolClient,
    entityId: string,
  ) {
    const matches = await client.query(
      `SELECT candidate.id::text AS candidate_id,candidate.programme_slug,
         candidate.name AS candidate_name,
         candidate.public_properties->>'sourceRef' AS candidate_source_ref,
         candidate.jurisdiction AS candidate_jurisdiction,
         ST_XMin(Box3D(candidate.geom)) AS candidate_min_x,
         ST_YMin(Box3D(candidate.geom)) AS candidate_min_y,
         ST_XMax(Box3D(candidate.geom)) AS candidate_max_x,
         ST_YMax(Box3D(candidate.geom)) AS candidate_max_y,
         existing.id::text AS existing_id,existing.name AS existing_name,
         existing.public_properties->>'sourceRef' AS existing_source_ref,
         existing.jurisdiction AS existing_jurisdiction,
         ST_XMin(Box3D(existing.geom)) AS existing_min_x,
         ST_YMin(Box3D(existing.geom)) AS existing_min_y,
         ST_XMax(Box3D(existing.geom)) AS existing_max_x,
         ST_YMax(Box3D(existing.geom)) AS existing_max_y
       FROM geodata_entity candidate
       JOIN geodata_entity existing ON existing.id<>candidate.id
         AND existing.programme_slug IS NOT DISTINCT FROM candidate.programme_slug
         AND existing.geom && candidate.geom
         AND (candidate.public_properties->>'sourceRef' IS NULL
           OR existing.public_properties->>'sourceRef' IS NULL
           OR existing.public_properties->>'sourceRef'<>
             candidate.public_properties->>'sourceRef')
       WHERE candidate.id=$1`,
      [entityId],
    );
    for (const row of matches.rows as Array<Record<string, unknown>>) {
      const score = scoreConflation(
        typeof row.candidate_name === 'string' ? row.candidate_name : '',
        textValue(row.candidate_source_ref) ?? '',
        textValue(row.candidate_jurisdiction),
        boxFromRow(row, 'candidate'),
        typeof row.existing_name === 'string' ? row.existing_name : '',
        textValue(row.existing_source_ref) ?? '',
        textValue(row.existing_jurisdiction),
        boxFromRow(row, 'existing'),
      );
      if (score.score < 0.55) continue;
      const [leftId, rightId] = [
        String(row.candidate_id),
        String(row.existing_id),
      ].sort();
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('geodata:conflation:' || $1 || ':' || $2,0))",
        [leftId, rightId],
      );
      const prior = await client.query(
        `SELECT 1 FROM conflation_candidate
         WHERE (left_entity_id=$1 AND right_entity_id=$2)
            OR (left_entity_id=$2 AND right_entity_id=$1) LIMIT 1`,
        [leftId, rightId],
      );
      if (prior.rows[0]) continue;
      const conflationId = createHash('sha256')
        .update(stringifyJsonWithBigInts([leftId, rightId]), 'utf8')
        .digest('hex')
        .slice(0, 32);
      await client.query(
        `INSERT INTO conflation_candidate
          (id,left_entity_id,right_entity_id,similarity,reason,resolution,resolution_history,
           programme_slug,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,'OPEN','[]'::jsonb,$6,now(),now())`,
        [
          conflationId,
          leftId,
          rightId,
          score.score,
          stringifyJsonWithBigInts(score.signals),
          row.programme_slug ?? null,
        ],
      );
    }
  }

  async retryPromotion(queue: PromotionQueue, error: unknown) {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await client.query(
        `UPDATE geodata_import_processing_queue SET status=$2,error=$3,
         lease_until=NULL,heartbeat_at=now(),completed_at=CASE WHEN $2='FAILED' THEN now() ELSE NULL END
         WHERE id=$1 AND status='PROCESSING' AND attempt_count=$4`,
        [
          queue.id,
          queue.attempt_count >= 3 ? 'FAILED' : 'QUEUED',
          errorMessage(error).slice(0, 2000),
          queue.attempt_count,
        ],
      );
      await client.query('COMMIT');
    } catch (failure) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw failure;
    } finally {
      client.release();
    }
  }

  private async promoteCandidate(queue: PromotionQueue, candidateId: string) {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const queueResult = await client.query(
        'SELECT status,attempt_count FROM geodata_import_processing_queue WHERE id=$1 FOR UPDATE',
        [queue.id],
      );
      if (
        queueResult.rows[0]?.status !== 'PROCESSING' ||
        Number(queueResult.rows[0]?.attempt_count) !== queue.attempt_count
      )
        throw new Error('geodata promotion lease was superseded');
      const selected = await client.query(
        `SELECT * FROM geodata_import_candidate
         WHERE id=$1 AND import_run_id=$2 FOR UPDATE`,
        [candidateId, queue.import_run_id],
      );
      const candidate = selected.rows[0];
      if (!candidate)
        throw new CandidateConflict('pre-processed candidate no longer exists');
      if (candidate.validation_status === 'PROCESSED') {
        await client.query('COMMIT');
        return {
          entityId: String(candidate.processed_entity_id),
          updated: Boolean(candidate.existing_entity_id),
        };
      }
      if (candidate.validation_status !== 'CONFIRMED')
        throw new CandidateConflict('only confirmed records can be promoted');
      if (candidate.processing_queue_id !== queue.id)
        throw new CandidateConflict('record belongs to another promotion job');

      const entityTypes = Array.isArray(candidate.entity_type_codes)
        ? candidate.entity_type_codes
        : JSON.parse(String(candidate.entity_type_codes));
      if (!entityTypes.length)
        throw new CandidateConflict('candidate has no entity type codes');
      const properties = isRecord(candidate.entity_payload)
        ? candidate.entity_payload
        : {};
      const source = isRecord(candidate.candidate_source)
        ? candidate.candidate_source
        : {};
      const candidateSource = isRecord(properties.candidateSource)
        ? properties.candidateSource
        : source;
      const sourceRef =
        (typeof candidate.source_ref === 'string' && candidate.source_ref) ||
        `${String(source.sourceKey ?? source.url ?? source.name ?? 'unknown-source')}:import-${queue.import_run_id}:record-${candidate.ordinal}`;
      const importRun = await client.query(
        'SELECT adapter_code,source_metadata FROM import_run WHERE id=$1',
        [queue.import_run_id],
      );
      const adapter = String(importRun.rows[0]?.adapter_code ?? 'MANUAL');
      const runMeta = importRun.rows[0]?.source_metadata as
        Record<string, unknown> | undefined;
      const runSource = isRecord(runMeta?.source) ? runMeta.source : {};
      const sourceKey =
        textValue(runSource.sourceKey ?? runSource.url ?? runSource.name) ??
        'unknown-source';
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('geodata:source:' || $1 || ':' || $2,0))",
        [adapter, sourceRef],
      );
      const sourceMapping = await client.query(
        'SELECT entity_id FROM source_reference WHERE adapter_code=$1 AND source_record_id=$2 FOR UPDATE',
        [adapter, sourceRef],
      );
      const existingEntityId =
        candidate.existing_entity_id ??
        sourceMapping.rows[0]?.entity_id ??
        null;
      const entityId =
        existingEntityId ?? candidate.planned_entity_id ?? randomUUID();
      const existing = existingEntityId
        ? await client.query(
            'SELECT lifecycle_status,website,description,public_properties FROM geodata_entity WHERE id=$1 FOR UPDATE',
            [entityId],
          )
        : { rows: [] };
      if (existing.rows[0]?.lifecycle_status === 'APPROVED')
        throw new CandidateConflict(
          'an approved entity cannot be changed by import processing',
        );

      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      const geometryType =
        isRecord(properties.geometry) &&
        typeof properties.geometry.type === 'string'
          ? properties.geometry.type.toUpperCase()
          : 'GEOMETRY';
      const titleCode = (code: string) =>
        code
          .replaceAll('_', ' ')
          .toLowerCase()
          .replace(/\b\w/g, (letter) => letter.toUpperCase());
      const categories: string[] = [];
      for (const rawCode of entityTypes) {
        const code = String(rawCode).toUpperCase();
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('geodata:category:' || $1,0))",
          [code],
        );
        const category = await client.query(
          'SELECT id FROM entity_type WHERE programme_id IS NULL AND code=$1 LIMIT 1',
          [code],
        );
        let categoryId = category.rows[0]?.id as string | undefined;
        if (!categoryId) {
          categoryId = randomUUID();
          await client.query(
            `INSERT INTO entity_type(id,programme_id,code,label,geometry_kind,config)
             VALUES ($1,NULL,$2,$3,$4,'{}'::jsonb)`,
            [categoryId, code, titleCode(code), geometryType],
          );
        }
        categories.push(categoryId);
      }
      const publicProperties = { ...properties };
      for (const field of [
        'geometry',
        'website',
        'description',
        'possibleDuplicates',
      ])
        delete publicProperties[field];
      const previousProperties = isRecord(existing.rows[0]?.public_properties)
        ? existing.rows[0].public_properties
        : {};
      const now = await utcTimestamp(client);
      const review =
        queue.target_status === 'APPROVED'
          ? {
              reviewerId: queue.requested_by,
              reviewedAt: now,
              note:
                textValue(queue.job_metadata.note) ??
                'Approved from validated import',
            }
          : (previousProperties.review ?? null);
      const reviewHistory = Array.isArray(previousProperties.reviewHistory)
        ? [...previousProperties.reviewHistory]
        : [];
      if (queue.target_status === 'APPROVED')
        reviewHistory.push({
          action: 'APPROVED',
          ...review,
          previousStatus: existing.rows[0]?.lifecycle_status ?? 'CANDIDATE',
        });
      Object.assign(publicProperties, {
        id: entityId,
        programmeSlug: candidate.programme_slug,
        entityType: entityTypes[0],
        entityTypes,
        entityTypeCodes: entityTypes,
        sourceRef,
        sourceState: 'CURRENT',
        candidateSource,
        provenance: {
          adapter,
          source: runSource,
          sourceKey,
          sourceHash: candidate.source_hash,
          importRunId: queue.import_run_id,
        },
        review,
        reviewHistory,
        updatedAt: now,
      });
      const website =
        existing.rows[0]?.website ?? textValue(properties.website);
      const description =
        existing.rows[0]?.description ?? textValue(properties.description);
      const attachments = Array.isArray(properties.attachments)
        ? properties.attachments
        : [];
      const nestedLocation = isRecord(properties.location)
        ? properties.location
        : {};
      const locationValue = (name: string) =>
        textValue(properties[name] ?? nestedLocation[name]);
      await client.query(
        `INSERT INTO geodata_entity
          (id,programme_id,entity_type_id,name,lifecycle_status,geom,centroid,public_properties,
           source_state,source_key,source_hash,jurisdiction,attachments,programme_slug,
           entity_type_code,website,description,continent,continent_code,country,country_code,
           region,region_code,subdivision,subdivision_code,province,province_code,county,
           county_code,city,municipality,locality)
         SELECT $1,NULL,$2,$3,$4,g,ST_Centroid(g)::geography,$5::jsonb,'CURRENT',$6,$7,$8,$9::jsonb,$10,$11,$12,$13,
           $14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28
         FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($29),4326) AS g) geometry
         ON CONFLICT (id) DO UPDATE SET entity_type_id=EXCLUDED.entity_type_id,
           entity_type_code=EXCLUDED.entity_type_code,name=EXCLUDED.name,
           lifecycle_status=EXCLUDED.lifecycle_status,geom=EXCLUDED.geom,centroid=EXCLUDED.centroid,
           public_properties=EXCLUDED.public_properties,source_state='CURRENT',source_key=EXCLUDED.source_key,
           source_hash=EXCLUDED.source_hash,jurisdiction=EXCLUDED.jurisdiction,
           attachments=EXCLUDED.attachments,programme_slug=EXCLUDED.programme_slug,
           website=EXCLUDED.website,description=EXCLUDED.description,
           continent=EXCLUDED.continent,continent_code=EXCLUDED.continent_code,
           country=EXCLUDED.country,country_code=EXCLUDED.country_code,
           region=EXCLUDED.region,region_code=EXCLUDED.region_code,
           subdivision=EXCLUDED.subdivision,subdivision_code=EXCLUDED.subdivision_code,
           province=EXCLUDED.province,province_code=EXCLUDED.province_code,
           county=EXCLUDED.county,county_code=EXCLUDED.county_code,
           city=EXCLUDED.city,municipality=EXCLUDED.municipality,
           locality=EXCLUDED.locality,updated_at=now()`,
        [
          entityId,
          categories[0],
          candidate.name,
          queue.target_status,
          stringifyJsonWithBigInts(publicProperties),
          sourceKey,
          candidate.source_hash,
          textValue(properties.jurisdiction),
          stringifyJsonWithBigInts(attachments),
          candidate.programme_slug,
          String(entityTypes[0]),
          website,
          description,
          locationValue('continent'),
          locationValue('continentCode'),
          locationValue('country'),
          locationValue('countryCode'),
          locationValue('region'),
          locationValue('regionCode'),
          locationValue('subdivision'),
          locationValue('subdivisionCode'),
          locationValue('province'),
          locationValue('provinceCode'),
          locationValue('county'),
          locationValue('countyCode'),
          locationValue('city'),
          locationValue('municipality'),
          locationValue('locality'),
          stringifyJsonWithBigInts(properties.geometry),
        ],
      );
      await client.query(
        'DELETE FROM geodata_entity_category WHERE entity_id=$1',
        [entityId],
      );
      for (let index = 0; index < entityTypes.length; index++)
        await client.query(
          `INSERT INTO geodata_entity_category(entity_id,category_id,category_code,is_primary,ordinal)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            entityId,
            categories[index],
            String(entityTypes[index]),
            index === 0,
            index,
          ],
        );
      await client.query('DELETE FROM source_reference WHERE entity_id=$1', [
        entityId,
      ]);
      await client.query(
        `INSERT INTO source_reference
         (id,entity_id,adapter_code,source_uri,source_record_id,license,attribution,retrieved_at,source_payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
         ON CONFLICT (adapter_code,source_record_id) DO UPDATE SET entity_id=EXCLUDED.entity_id,
           source_uri=EXCLUDED.source_uri,license=EXCLUDED.license,attribution=EXCLUDED.attribution,
           retrieved_at=EXCLUDED.retrieved_at,source_payload=EXCLUDED.source_payload`,
        [
          randomUUID(),
          entityId,
          adapter,
          textValue(runSource.url ?? runSource.uri),
          sourceRef,
          textValue(runSource.license),
          textValue(runSource.attribution),
          runSource.retrievedAt ?? null,
          stringifyJsonWithBigInts({
            ...properties,
            geometry: properties.geometry,
          }),
        ],
      );
      await this.createConflationCandidates(client, entityId);
      if (['APPROVED', 'CANDIDATE'].includes(queue.target_status)) {
        const state = await client.query(
          `SELECT ST_AsGeoJSON(geom)::jsonb AS geometry,public_properties,
            continent,continent_code,country,country_code,region,region_code,
            subdivision,subdivision_code,province,province_code,county,county_code,
            city,municipality,locality,manual_location_fields
           FROM geodata_entity WHERE id=$1 FOR UPDATE`,
          [entityId],
        );
        const entity = state.rows[0];
        if (entity) {
          const enrichment = queueLocationEnrichment(
            entityId,
            isRecord(entity.public_properties) ? entity.public_properties : {},
            entity.geometry,
            locationSnapshot(entity),
            entity.manual_location_fields,
            'LIFECYCLE_PROMOTED',
            queue.requested_by,
            true,
            await utcTimestamp(client),
          );
          if (enrichment) {
            await client.query(
              `UPDATE geodata_entity SET public_properties=$2::jsonb,
                location_work_dispatched_at=now() WHERE id=$1`,
              [entityId, stringifyJsonWithBigInts(enrichment.properties)],
            );
            await this.writeFact(
              client,
              'geodata.entity.location-enrichment-requested.v1',
              'entity',
              entityId,
              enrichment.event,
              enrichment.requestedAt,
            );
          }
        }
      }
      const eventType = existingEntityId
        ? 'geodata.entity.import-updated.v1'
        : queue.target_status === 'APPROVED'
          ? 'geodata.entity.import-approved.v1'
          : 'geodata.entity.candidate.created.v1';
      const eventPayload = {
        entityId,
        status: queue.target_status,
        importRunId: queue.import_run_id,
        actor: queue.requested_by,
      };
      await client.query(
        `INSERT INTO geodata_audit_event(event_id,aggregate_type,aggregate_id,event,occurred_at)
         VALUES ($1,'entity',$2,$3::jsonb,$4)`,
        [
          randomUUID(),
          entityId,
          stringifyJsonWithBigInts({ eventType, ...eventPayload }),
          now,
        ],
      );
      await this.writeFact(
        client,
        eventType,
        'entity',
        entityId,
        eventPayload,
        now,
      );
      await client.query(
        `UPDATE geodata_import_candidate SET
         existing_entity_id=CASE WHEN $6 THEN $3 ELSE existing_entity_id END,planned_entity_id=$3,
         validation_status='PROCESSED',target_status=$4,processed_entity_id=$3,
         processed_at=$5,updated_at=$5 WHERE id=$1 AND import_run_id=$2`,
        [
          candidateId,
          queue.import_run_id,
          entityId,
          queue.target_status,
          now,
          Boolean(existingEntityId),
        ],
      );
      await client.query('COMMIT');
      return { entityId, updated: Boolean(existingEntityId) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async heartbeatPromotion(queue: PromotionQueue) {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await client.query(
        `UPDATE geodata_import_processing_queue
         SET heartbeat_at=now(),lease_until=now()+interval '5 minutes'
         WHERE id=$1 AND status='PROCESSING' AND attempt_count=$2`,
        [queue.id, queue.attempt_count],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async writeFact(
    client: PoolClient,
    type: string,
    aggregateType: string,
    aggregateId: string,
    payload: Record<string, unknown>,
    occurredAt?: Date | string,
  ) {
    const eventTimestamp = occurredAt ?? (await utcTimestamp(client));
    await client.query(
      `INSERT INTO outbox_event
       (event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
       VALUES ($1,$2,'geodata-worker',$3,$4,$5::jsonb,$6,$7)`,
      [
        randomUUID(),
        type,
        aggregateType,
        aggregateId,
        stringifyJsonWithBigInts(payload),
        eventTimestamp,
        randomUUID(),
      ],
    );
  }

  private async connect(): Promise<PoolClient> {
    if (!this.pool)
      throw new ServiceUnavailableException(
        'Geodata database is not configured',
      );
    try {
      return await this.pool.connect();
    } catch {
      throw new ServiceUnavailableException('Geodata database is unavailable');
    }
  }
}

class CandidateConflict extends Error {}

function isCandidateConflict(error: unknown) {
  if (error instanceof CandidateConflict) return true;
  if (typeof error !== 'object' || error === null || Array.isArray(error))
    return false;
  const code = (error as Record<string, unknown>).code;
  return typeof code === 'string' && code.startsWith('23');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function textValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

type BoundingBox = [number, number, number, number];

function boxFromRow(row: Record<string, unknown>, prefix: string): BoundingBox {
  return [
    Number(row[`${prefix}_min_x`]),
    Number(row[`${prefix}_min_y`]),
    Number(row[`${prefix}_max_x`]),
    Number(row[`${prefix}_max_y`]),
  ];
}

function scoreConflation(
  candidateName: string,
  candidateRef: string,
  candidateJurisdiction: string | null,
  candidateBox: BoundingBox,
  existingName: string,
  existingRef: string,
  existingJurisdiction: string | null,
  existingBox: BoundingBox,
) {
  const normalizedCandidate = unicodeCaseFold(pythonStrip(candidateName));
  const normalizedExisting = unicodeCaseFold(pythonStrip(existingName));
  const nameScore =
    normalizedCandidate && normalizedExisting
      ? sequenceMatcherRatio(normalizedCandidate, normalizedExisting)
      : 0;
  const sourceIdentifier = candidateRef && candidateRef === existingRef ? 1 : 0;
  const intersection = boxIntersection(candidateBox, existingBox);
  const candidateArea = boxArea(candidateBox);
  const existingArea = boxArea(existingBox);
  const union = candidateArea + existingArea - intersection;
  const overlap = union ? intersection / union : 0;
  const containment =
    candidateBox[0] >= existingBox[0] &&
    candidateBox[1] >= existingBox[1] &&
    candidateBox[2] <= existingBox[2] &&
    candidateBox[3] <= existingBox[3]
      ? 1
      : 0;
  const distanceKm = haversineKm(
    boxCenter(candidateBox),
    boxCenter(existingBox),
  );
  const distanceScore = Math.max(0, 1 - distanceKm / 2);
  const jurisdiction =
    candidateJurisdiction && candidateJurisdiction === existingJurisdiction
      ? 1
      : 0;
  const score = round6(
    sourceIdentifier * 0.3 +
      nameScore * 0.2 +
      containment * 0.2 +
      overlap * 0.15 +
      distanceScore * 0.1 +
      jurisdiction * 0.05,
  );
  return {
    score,
    signals: {
      sourceIdentifier,
      name: round6(nameScore),
      containment,
      overlap: round6(overlap),
      distanceKm: round6(distanceKm),
      jurisdiction,
    },
  };
}

function sequenceMatcherRatio(left: string, right: string) {
  const leftSymbols = Array.from(left);
  const rightSymbols = Array.from(right);
  if (!leftSymbols.length && !rightSymbols.length) return 1;

  const popular = new Set<string>();
  if (rightSymbols.length >= 200) {
    const counts = new Map<string, number>();
    for (const symbol of rightSymbols)
      counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    const popularityThreshold = Math.floor(rightSymbols.length / 100) + 1;
    for (const [symbol, count] of counts)
      if (count > popularityThreshold) popular.add(symbol);
  }
  const rightIndices = new Map<string, number[]>();
  for (let index = 0; index < rightSymbols.length; index += 1) {
    const symbol = rightSymbols[index];
    if (popular.has(symbol)) continue;
    const indices = rightIndices.get(symbol);
    if (indices) indices.push(index);
    else rightIndices.set(symbol, [index]);
  }

  const pending: [number, number, number, number][] = [
    [0, leftSymbols.length, 0, rightSymbols.length],
  ];
  let matchingCharacters = 0;
  while (pending.length) {
    const [leftStart, leftEnd, rightStart, rightEnd] = pending.pop()!;
    let bestLeft = leftStart;
    let bestRight = rightStart;
    let bestSize = 0;
    let previous = new Map<number, number>();
    for (let leftIndex = leftStart; leftIndex < leftEnd; leftIndex += 1) {
      const current = new Map<number, number>();
      for (const rightIndex of rightIndices.get(leftSymbols[leftIndex]) ?? []) {
        if (rightIndex < rightStart) continue;
        if (rightIndex >= rightEnd) break;
        const size = (previous.get(rightIndex - 1) ?? 0) + 1;
        current.set(rightIndex, size);
        if (size > bestSize) {
          bestLeft = leftIndex - size + 1;
          bestRight = rightIndex - size + 1;
          bestSize = size;
        }
      }
      previous = current;
    }

    while (
      bestLeft > leftStart &&
      bestRight > rightStart &&
      leftSymbols[bestLeft - 1] === rightSymbols[bestRight - 1]
    ) {
      bestLeft -= 1;
      bestRight -= 1;
      bestSize += 1;
    }
    while (
      bestLeft + bestSize < leftEnd &&
      bestRight + bestSize < rightEnd &&
      leftSymbols[bestLeft + bestSize] === rightSymbols[bestRight + bestSize]
    )
      bestSize += 1;

    if (!bestSize) continue;
    matchingCharacters += bestSize;
    if (leftStart < bestLeft && rightStart < bestRight)
      pending.push([leftStart, bestLeft, rightStart, bestRight]);
    const leftAfter = bestLeft + bestSize;
    const rightAfter = bestRight + bestSize;
    if (leftAfter < leftEnd && rightAfter < rightEnd)
      pending.push([leftAfter, leftEnd, rightAfter, rightEnd]);
  }
  return (2 * matchingCharacters) / (leftSymbols.length + rightSymbols.length);
}

function boxArea(box: BoundingBox) {
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
}

function boxIntersection(left: BoundingBox, right: BoundingBox) {
  const minX = Math.max(left[0], right[0]);
  const minY = Math.max(left[1], right[1]);
  const maxX = Math.min(left[2], right[2]);
  const maxY = Math.min(left[3], right[3]);
  if (minX >= maxX || minY >= maxY) return 0;
  return (maxX - minX) * (maxY - minY);
}

function boxCenter(box: BoundingBox) {
  return {
    lon: pythonRound((box[0] + box[2]) / 2, 7),
    lat: pythonRound((box[1] + box[3]) / 2, 7),
  };
}

function haversineKm(
  left: { lon: number; lat: number },
  right: { lon: number; lat: number },
) {
  const radius = 6371.0088;
  const lat1 = (left.lat * Math.PI) / 180;
  const lat2 = (right.lat * Math.PI) / 180;
  const deltaLat = lat2 - lat1;
  const deltaLon = ((right.lon - left.lon) * Math.PI) / 180;
  const term =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return (
    radius * 2 * Math.atan2(Math.sqrt(term), Math.sqrt(Math.max(0, 1 - term)))
  );
}

function round6(value: number) {
  return pythonRound(value, 6);
}
