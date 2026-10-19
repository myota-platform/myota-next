import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { decodeShapefileArchive } from './geodata-shapefile.js';
import { inferFeatureName } from './geodata-feature-name.js';

interface ImportRun {
  id: string;
  adapter_code: string;
  source_metadata: Record<string, unknown>;
  source_key: string;
  source_hash: string;
  attempt_count: number;
  complete_snapshot: boolean;
}

interface PreparedCandidate {
  ordinal: number;
  name: string;
  geometry: string;
  properties: Record<string, unknown>;
  sourceRef: string | null;
  possibleDuplicates: Record<string, unknown>[];
}

@Injectable()
export class GeodataWorkRepository {
  private storage: S3Client | undefined;

  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async claim(runId?: string): Promise<ImportRun | null> {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const cancellation = runId
        ? { rows: [] as ImportRun[] }
        : await client.query(
            `SELECT id,adapter_code,source_metadata,source_key,source_hash,attempt_count,complete_snapshot
         FROM import_run WHERE status='CANCELLING'
         ORDER BY cancellation_requested_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,
          );
      const pendingCancellation = cancellation.rows[0] as ImportRun | undefined;
      if (pendingCancellation) {
        await client.query(
          "SELECT set_config('myota.geodata_writer','row-v1',true)",
        );
        await client.query(
          'DELETE FROM geodata_import_candidate WHERE import_run_id=$1',
          [pendingCancellation.id],
        );
        await client.query(
          `UPDATE import_run SET status='CANCELLED',completed_at=now(),heartbeat_at=NULL,
           lease_until=NULL,last_error=NULL,
           stats='{"preprocessed":0,"created":0,"updated":0,"skipped":0,"errors":0,"disappeared":0}'::jsonb
           WHERE id=$1`,
          [pendingCancellation.id],
        );
        await client.query(
          `INSERT INTO outbox_event
           (event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
           VALUES ($1,'geodata.import.cancelled.v1','geodata-worker','import_run',$2,$3::jsonb,now(),$4)`,
          [
            randomUUID(),
            pendingCancellation.id,
            JSON.stringify({ importRunId: pendingCancellation.id }),
            randomUUID(),
          ],
        );
        await client.query('COMMIT');
        await this.deleteSource(pendingCancellation);
        return null;
      }
      const found = await client.query(
        `SELECT id,adapter_code,source_metadata,source_key,source_hash,attempt_count,complete_snapshot
         FROM import_run
         WHERE source_key IS NOT NULL AND ($1::uuid IS NULL OR id=$1) AND
           (status='QUEUED' OR (status='PROCESSING' AND lease_until < now()))
         ORDER BY started_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,
        [runId ?? null],
      );
      const row = found.rows[0] as ImportRun | undefined;
      if (!row) {
        await client.query('COMMIT');
        return null;
      }
      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await client.query(
        `UPDATE import_run SET status='PROCESSING',attempt_count=attempt_count+1,
         heartbeat_at=now(),lease_until=now()+interval '5 minutes',last_error=NULL
         WHERE id=$1`,
        [row.id],
      );
      await client.query('COMMIT');
      return { ...row, attempt_count: Number(row.attempt_count) + 1 };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getRunState(runId: string): Promise<{
    status: string;
    leaseRemainingSeconds: number;
  } | null> {
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT status,GREATEST(0,EXTRACT(EPOCH FROM (lease_until-now()))) AS lease_remaining
         FROM import_run WHERE id=$1`,
        [runId],
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

  async staleCancellationIds(limit = 100): Promise<string[]> {
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT id FROM import_run WHERE status='CANCELLING'
           AND (lease_until IS NULL OR lease_until<=now())
         ORDER BY cancellation_requested_at,id LIMIT $1`,
        [limit],
      );
      return result.rows.map((row) => String(row.id));
    } finally {
      client.release();
    }
  }

  async recoverExpiredWorkDispatches(
    ageSeconds = Math.max(
      300,
      Number(process.env.GEODATA_WORK_RECOVERY_AGE_SECONDS ?? 300),
    ),
    batchSize = 50,
  ): Promise<
    Record<'preprocessing' | 'promotion' | 'deletion' | 'location', number>
  > {
    const client = await this.connect();
    const recovered = {
      preprocessing: 0,
      promotion: 0,
      deletion: 0,
      location: 0,
    };
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      const runs = await client.query(
        `SELECT id::text,status FROM import_run WHERE status IN ('QUEUED','PROCESSING')
           AND work_dispatched_at<=now()-make_interval(secs=>$1)
           AND (status='QUEUED' OR lease_until IS NULL OR lease_until<=now())
         ORDER BY work_dispatched_at,id FOR UPDATE SKIP LOCKED LIMIT $2`,
        [ageSeconds, batchSize],
      );
      for (const row of runs.rows) {
        if (row.status === 'PROCESSING') {
          await client.query(
            `UPDATE import_run SET status='QUEUED',heartbeat_at=NULL,lease_until=NULL,
               last_error='Expired lease re-dispatched through JetStream',work_dispatched_at=now()
             WHERE id=$1`,
            [row.id],
          );
        } else {
          await client.query(
            'UPDATE import_run SET work_dispatched_at=now() WHERE id=$1',
            [row.id],
          );
        }
        await this.insertRecoveryEvent(
          client,
          'geodata.import.recovered.v1',
          'import_run',
          row.id,
          {
            importRunId: row.id,
            natsSubject: 'myota.geodata.import.preprocess.v1',
          },
        );
        recovered.preprocessing++;
      }

      const queues = await client.query(
        `SELECT id::text,status FROM geodata_import_processing_queue
         WHERE status IN ('QUEUED','PROCESSING')
           AND work_dispatched_at<=now()-make_interval(secs=>$1)
           AND (status='QUEUED' OR lease_until IS NULL OR lease_until<=now())
         ORDER BY work_dispatched_at,id FOR UPDATE SKIP LOCKED LIMIT $2`,
        [ageSeconds, batchSize],
      );
      for (const row of queues.rows) {
        if (row.status === 'PROCESSING') {
          await client.query(
            `UPDATE geodata_import_processing_queue SET status='QUEUED',heartbeat_at=NULL,
               lease_until=NULL,error='Expired lease re-dispatched through JetStream',work_dispatched_at=now()
             WHERE id=$1`,
            [row.id],
          );
        } else {
          await client.query(
            'UPDATE geodata_import_processing_queue SET work_dispatched_at=now() WHERE id=$1',
            [row.id],
          );
        }
        await this.insertRecoveryEvent(
          client,
          'geodata.import.processing.recovered.v1',
          'import_processing_queue',
          row.id,
          { queueId: row.id, natsSubject: 'myota.geodata.import.process.v1' },
        );
        recovered.promotion++;
      }

      const deletionJobs = await client.query(
        `SELECT id::text,payload FROM geodata_control_record WHERE kind='entityDeletionJobs'
           AND ((payload->>'status'='QUEUED' AND updated_at<=now()-make_interval(secs=>$1))
             OR (payload->>'status'='PROCESSING'
               AND (NULLIF(payload->>'leaseUntil','') IS NULL
                 OR (payload->>'leaseUntil')::timestamptz<=now())
               AND updated_at<=now()-make_interval(secs=>$1)))
         ORDER BY updated_at,id FOR UPDATE SKIP LOCKED LIMIT $2`,
        [ageSeconds, batchSize],
      );
      for (const row of deletionJobs.rows) {
        const payload = isRecord(row.payload) ? row.payload : {};
        if (payload.status === 'PROCESSING') {
          await client.query(
            `UPDATE geodata_control_record SET payload=payload ||
               jsonb_build_object('status','QUEUED','leaseUntil',NULL),updated_at=now()
             WHERE kind='entityDeletionJobs' AND id=$1`,
            [row.id],
          );
        } else {
          await client.query(
            `UPDATE geodata_control_record SET updated_at=now()
             WHERE kind='entityDeletionJobs' AND id=$1`,
            [row.id],
          );
        }
        await this.insertRecoveryEvent(
          client,
          'geodata.entity-deletion-job.queued.v1',
          'entity_deletion_job',
          row.id,
          { jobId: row.id, natsSubject: 'myota.geodata.entity.delete.v1' },
        );
        recovered.deletion++;
      }

      const locations = await client.query(
        `SELECT id::text,public_properties->>'locationEnrichmentRequestId' AS request_id,
           public_properties->>'locationEnrichmentGeometryHash' AS geometry_hash,
           coalesce((public_properties->>'locationEnrichmentOnlyMissing')::boolean,false) AS only_missing,
           public_properties->>'locationEnrichmentReason' AS reason
         FROM geodata_entity WHERE public_properties->>'locationEnrichmentStatus'='QUEUED'
           AND public_properties ? 'locationEnrichmentReason'
           AND location_work_dispatched_at<=now()-make_interval(secs=>$1)
         ORDER BY location_work_dispatched_at,id FOR UPDATE SKIP LOCKED LIMIT $2`,
        [ageSeconds, batchSize],
      );
      for (const row of locations.rows) {
        if (!row.request_id || !row.geometry_hash || !row.reason) continue;
        await client.query(
          'UPDATE geodata_entity SET location_work_dispatched_at=now() WHERE id=$1',
          [row.id],
        );
        await this.insertRecoveryEvent(
          client,
          'geodata.entity.location-enrichment-requested.v1',
          'entity',
          row.id,
          {
            entityId: row.id,
            requestId: row.request_id,
            geometryHash: row.geometry_hash,
            onlyMissing: row.only_missing,
            reason: row.reason,
            natsSubject: 'myota.geodata.entity.location-enrichment.v1',
          },
        );
        recovered.location++;
      }
      await client.query('COMMIT');
      return recovered;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertRecoveryEvent(
    client: PoolClient,
    eventType: string,
    aggregateType: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO outbox_event(event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at)
       VALUES ($1,$2,'geodata-worker',$3,$4,$5::jsonb,now())`,
      [
        randomUUID(),
        eventType,
        aggregateType,
        aggregateId,
        JSON.stringify(payload),
      ],
    );
  }

  async recordWorkDeadLetter(
    eventId: string,
    workType: string,
    envelope: Record<string, unknown>,
    attempts: number,
    error: unknown,
  ): Promise<void> {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await client.query(
        `INSERT INTO dead_letter_event(event_id,event_type,payload,attempts,error)
         VALUES ($1,$2,$3::jsonb,$4,$5)
         ON CONFLICT (event_id) DO UPDATE SET
           attempts=GREATEST(dead_letter_event.attempts,EXCLUDED.attempts),
           error=EXCLUDED.error,dead_lettered_at=now(),resolved_at=NULL`,
        [
          eventId,
          workType,
          JSON.stringify(envelope),
          Math.max(1, attempts),
          error instanceof Error
            ? error.message.slice(0, 1000)
            : String(error).slice(0, 1000),
        ],
      );
      const aggregate = isRecord(envelope.aggregate) ? envelope.aggregate : {};
      if (aggregate.type === 'import_run' && typeof aggregate.id === 'string') {
        await client.query(
          `UPDATE import_run SET status='FAILED',last_error='work delivery exhausted',
             completed_at=now(),heartbeat_at=NULL,lease_until=NULL
           WHERE id=$1 AND status IN ('QUEUED','PROCESSING')`,
          [aggregate.id],
        );
      } else if (
        aggregate.type === 'import_processing_queue' &&
        typeof aggregate.id === 'string'
      ) {
        await client.query(
          `UPDATE geodata_import_processing_queue SET status='FAILED',error='work delivery exhausted',
             completed_at=now(),heartbeat_at=NULL,lease_until=NULL
           WHERE id=$1 AND status IN ('QUEUED','PROCESSING')`,
          [aggregate.id],
        );
      } else if (
        aggregate.type === 'entity' &&
        typeof aggregate.id === 'string' &&
        isRecord(envelope.payload) &&
        typeof envelope.payload.requestId === 'string'
      ) {
        await client.query(
          `UPDATE geodata_entity SET public_properties=public_properties ||
             jsonb_build_object('locationEnrichmentStatus','FAILED',
               'locationEnrichmentCompletedAt',now()),updated_at=now()
           WHERE id=$1 AND public_properties->>'locationEnrichmentRequestId'=$2
             AND public_properties->>'locationEnrichmentStatus' IN ('QUEUED','PROCESSING')`,
          [aggregate.id, envelope.payload.requestId],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async preprocess(run: ImportRun) {
    const bucket = String(
      process.env.MYOTA_GEODATA_IMPORT_BUCKET ?? 'myota-geodata-imports',
    );
    const object = await this.storageClient().send(
      new GetObjectCommand({ Bucket: bucket, Key: run.source_key }),
    );
    if (!object.Body)
      throw new Error('geodata import source object has no content');
    const raw = Buffer.from(await object.Body.transformToByteArray());
    if (raw.length > 20 * 1024 * 1024)
      throw new Error('geodata import exceeds the 20 MiB limit');
    if (
      run.source_hash &&
      createHash('sha256').update(raw).digest('hex') !== run.source_hash
    )
      throw new Error(
        'geodata import source hash does not match its queued record',
      );
    const format =
      typeof run.source_metadata.format === 'string'
        ? run.source_metadata.format.toUpperCase()
        : 'GEOJSON';
    const filename =
      typeof run.source_metadata.filename === 'string'
        ? run.source_metadata.filename
        : '';
    const document: unknown =
      format === 'SHAPEFILE' || format === 'SHP'
        ? await decodeShapefileArchive(raw, filename)
        : JSON.parse(raw.toString('utf8'));
    if (
      !isRecord(document) ||
      document.type !== 'FeatureCollection' ||
      !Array.isArray(document.features)
    )
      throw new Error('stored source is not a supported FeatureCollection');
    const featureLimit = boundedFeatureLimit(
      process.env.GEODATA_MAX_IMPORT_FEATURES,
    );
    if (document.features.length > featureLimit)
      throw new Error(
        `geodata import contains more than ${featureLimit} features`,
      );

    const errors: Record<string, unknown>[] = [];
    const prepared: PreparedCandidate[] = [];
    const source = isRecord(run.source_metadata.source)
      ? run.source_metadata.source
      : {};
    const sourceKey =
      textValue(source.sourceKey ?? source.url ?? source.name) ??
      'unknown-source';
    for (let index = 0; index < document.features.length; index++) {
      if (index > 0 && index % 100 === 0) await this.heartbeat(run);
      const feature = document.features[index];
      if (!isRecord(feature) || feature.type !== 'Feature') {
        errors.push({
          ordinal: index,
          message: 'feature must be a GeoJSON Feature',
        });
        continue;
      }
      const properties = isRecord(feature.properties)
        ? { ...feature.properties }
        : {};
      const name = inferFeatureName(properties);
      if (!name || name.length > 300) {
        errors.push({
          ordinal: index,
          message:
            'feature properties.name is required and must be at most 300 characters',
        });
        continue;
      }
      properties.name = name;
      if (
        !isRecord(feature.geometry) ||
        typeof feature.geometry.type !== 'string'
      ) {
        errors.push({
          ordinal: index,
          message: 'feature geometry is required',
        });
        continue;
      }
      const geometry = JSON.stringify(feature.geometry);
      const client = await this.connect();
      try {
        const checked = await client.query(
          `SELECT ST_IsValid(g) AS valid,ST_IsEmpty(g) AS empty,
             ST_XMin(Box3D(g)) AS min_x,ST_XMax(Box3D(g)) AS max_x,
             ST_YMin(Box3D(g)) AS min_y,ST_YMax(Box3D(g)) AS max_y
           FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1),4326) AS g) parsed`,
          [geometry],
        );
        const row = checked.rows[0];
        if (
          !row?.valid ||
          row.empty ||
          Number(row.min_x) < -180 ||
          Number(row.max_x) > 180 ||
          Number(row.min_y) < -90 ||
          Number(row.max_y) > 90
        ) {
          errors.push({
            ordinal: index,
            message: 'geometry is empty, invalid, or outside WGS84 bounds',
          });
          continue;
        }
        const duplicates = await client.query(
          `WITH candidate AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1),4326) AS geometry)
           SELECT e.id::text AS id,e.name,e.lifecycle_status AS status,e.entity_type_code AS entity_type,
             ST_AsGeoJSON(e.geom)::jsonb AS geometry,
             CASE WHEN ST_Equals(e.geom,candidate.geometry) THEN 'IDENTICAL_GEOMETRY' ELSE 'WITHIN_50_METERS' END AS match_type,
             round(ST_Distance(e.geom::geography,candidate.geometry::geography)::numeric,1) AS distance_meters
           FROM geodata_entity e CROSS JOIN candidate
           WHERE e.lifecycle_status IN ('APPROVED','CANDIDATE')
             AND ST_DWithin(e.geom::geography,candidate.geometry::geography,50)
           ORDER BY ST_Distance(e.geom::geography,candidate.geometry::geography) LIMIT 10`,
          [geometry],
        );
        prepared.push({
          ordinal: index,
          name,
          geometry,
          properties,
          sourceRef:
            textValue(
              properties.sourceRef ??
                properties.id ??
                properties['@id'] ??
                feature.id,
            ) ?? `${sourceKey}:import-${run.id}:record-${index}`,
          possibleDuplicates: duplicates.rows.map((duplicate) => ({
            entityId: duplicate.id,
            name: duplicate.name,
            status: duplicate.status,
            entityTypes: duplicate.entity_type ? [duplicate.entity_type] : [],
            geometry: duplicate.geometry,
            distanceMeters: Number(duplicate.distance_meters),
            matchType: duplicate.match_type,
          })),
        });
      } finally {
        client.release();
      }
    }
    await this.saveCandidates(run, prepared, errors, document.features.length);
  }

  async fail(run: ImportRun, error: unknown): Promise<boolean> {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        'SELECT status FROM import_run WHERE id=$1 FOR UPDATE',
        [run.id],
      );
      if (current.rows[0]?.status === 'CANCELLING') {
        await client.query(
          "SELECT set_config('myota.geodata_writer','row-v1',true)",
        );
        await client.query(
          'DELETE FROM geodata_import_candidate WHERE import_run_id=$1',
          [run.id],
        );
        await client.query(
          `UPDATE import_run SET status='CANCELLED',completed_at=now(),heartbeat_at=NULL,
           lease_until=NULL,last_error=NULL,
           stats='{"preprocessed":0,"created":0,"updated":0,"skipped":0,"errors":0,"disappeared":0}'::jsonb
           WHERE id=$1`,
          [run.id],
        );
        await client.query(
          `INSERT INTO outbox_event
           (event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
           VALUES ($1,'geodata.import.cancelled.v1','geodata-worker','import_run',$2,$3::jsonb,now(),$4)`,
          [
            randomUUID(),
            run.id,
            JSON.stringify({ importRunId: run.id }),
            randomUUID(),
          ],
        );
        await client.query('COMMIT');
        await this.deleteSource(run);
        return true;
      }
      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      const exhausted = run.attempt_count >= 3;
      await client.query(
        `UPDATE import_run SET status=$2,last_error=$3,heartbeat_at=now(),
         lease_until=NULL,completed_at=CASE WHEN $2='FAILED' THEN now() ELSE NULL END
         WHERE id=$1 AND status='PROCESSING' AND attempt_count=$4`,
        [
          run.id,
          exhausted ? 'FAILED' : 'QUEUED',
          errorMessage(error).slice(0, 2000),
          run.attempt_count,
        ],
      );
      await client.query('COMMIT');
      return false;
    } catch (failure) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw failure;
    } finally {
      client.release();
    }
  }

  async finalizeStaleCancellation(runId: string): Promise<boolean> {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        `SELECT id,adapter_code,source_metadata,source_key,source_hash,attempt_count,complete_snapshot
         FROM import_run WHERE id=$1 AND status='CANCELLING'
           AND (lease_until IS NULL OR lease_until<=now()) FOR UPDATE`,
        [runId],
      );
      const run = selected.rows[0] as ImportRun | undefined;
      if (!run) {
        await client.query('COMMIT');
        return false;
      }
      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await client.query(
        'DELETE FROM geodata_import_candidate WHERE import_run_id=$1',
        [run.id],
      );
      await client.query(
        `UPDATE import_run SET status='CANCELLED',completed_at=now(),heartbeat_at=NULL,lease_until=NULL,last_error=NULL,
         stats='{"preprocessed":0,"created":0,"updated":0,"skipped":0,"errors":0,"disappeared":0}'::jsonb WHERE id=$1`,
        [run.id],
      );
      await client.query(
        `INSERT INTO outbox_event(event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
         VALUES ($1,'geodata.import.cancelled.v1','geodata-worker','import_run',$2,$3::jsonb,now(),$4)`,
        [
          randomUUID(),
          run.id,
          JSON.stringify({ importRunId: run.id }),
          randomUUID(),
        ],
      );
      await client.query('COMMIT');
      await this.deleteSource(run);
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async deleteSource(run: ImportRun) {
    const sourceObject = isRecord(run.source_metadata.sourceObject)
      ? run.source_metadata.sourceObject
      : {};
    const bucket =
      typeof sourceObject.bucket === 'string'
        ? sourceObject.bucket
        : (process.env.MYOTA_GEODATA_IMPORT_BUCKET ?? 'myota-geodata-imports');
    const key =
      typeof sourceObject.key === 'string' ? sourceObject.key : run.source_key;
    if (
      bucket !==
        (process.env.MYOTA_GEODATA_IMPORT_BUCKET ?? 'myota-geodata-imports') ||
      !key
    )
      return;
    await this.storageClient()
      .send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
      .catch(() => undefined);
  }

  private async saveCandidates(
    run: ImportRun,
    candidates: PreparedCandidate[],
    errors: Record<string, unknown>[],
    featureCount: number,
  ) {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const lockedRun = await client.query(
        'SELECT status,attempt_count FROM import_run WHERE id=$1 FOR UPDATE',
        [run.id],
      );
      if (
        lockedRun.rows[0]?.status !== 'PROCESSING' ||
        Number(lockedRun.rows[0]?.attempt_count) !== run.attempt_count
      )
        throw new Error('geodata import lease was superseded');
      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      const entityTypes = Array.isArray(run.source_metadata.entityTypes)
        ? run.source_metadata.entityTypes
        : [];
      const programmeSlug =
        typeof run.source_metadata.programmeSlug === 'string'
          ? run.source_metadata.programmeSlug
          : null;
      const proposal = isRecord(run.source_metadata.communityProposal)
        ? run.source_metadata.communityProposal
        : undefined;
      const autoPromote = isRecord(run.source_metadata.autoPromote)
        ? run.source_metadata.autoPromote
        : undefined;
      const promotionActor =
        textValue(proposal?.proposerId) ?? textValue(autoPromote?.requestedBy);
      const promotionQueueId =
        promotionActor &&
        (candidates.length > 0 ||
          (run.complete_snapshot && featureCount === 0 && errors.length === 0))
          ? randomUUID()
          : null;
      const created: Record<string, unknown>[] = [];
      const preprocessed: Record<string, unknown>[] = [];
      for (const candidate of candidates) {
        const id = randomUUID();
        const entityPayload = {
          ...candidate.properties,
          entityType: entityTypes[0] ?? null,
          entityTypes,
          entityTypeCodes: entityTypes,
          geometry: JSON.parse(candidate.geometry),
          possibleDuplicates: candidate.possibleDuplicates,
        };
        await client.query(
          `INSERT INTO geodata_import_candidate
            (id,import_run_id,ordinal,programme_slug,entity_type_codes,name,geom,
             candidate_source,source_ref,source_hash,provenance,entity_payload)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,ST_SetSRID(ST_GeomFromGeoJSON($7),4326),
             $8::jsonb,$9,$10,$11::jsonb,$12::jsonb)`,
          [
            id,
            run.id,
            candidate.ordinal,
            programmeSlug,
            JSON.stringify(entityTypes),
            candidate.name,
            candidate.geometry,
            JSON.stringify(run.source_metadata.source ?? {}),
            candidate.sourceRef,
            run.source_hash,
            JSON.stringify({
              adapter: run.adapter_code,
              sourceHash: run.source_hash,
            }),
            JSON.stringify(entityPayload),
          ],
        );
        if (promotionActor && promotionQueueId)
          await client.query(
            `UPDATE geodata_import_candidate SET validation_status='CONFIRMED',
             validated_by=$2,validated_at=now(),target_status='CANDIDATE',
             processing_queue_id=$3 WHERE id=$1`,
            [id, promotionActor, promotionQueueId],
          );
        const summary = {
          candidateId: id,
          ordinal: candidate.ordinal,
          name: candidate.name,
          possibleDuplicates: candidate.possibleDuplicates,
        };
        created.push(summary);
        preprocessed.push(summary);
      }
      if (promotionActor && promotionQueueId) {
        await client.query(
          `INSERT INTO geodata_import_processing_queue
            (id,import_run_id,candidate_ids,target_status,requested_by,status,job_metadata)
           VALUES ($1,$2,$3::jsonb,'CANDIDATE',$4,'QUEUED',$5::jsonb)`,
          [
            promotionQueueId,
            run.id,
            JSON.stringify(
              preprocessed.map((candidate) => candidate.candidateId),
            ),
            promotionActor,
            JSON.stringify({
              note: textValue(autoPromote?.note) ?? 'Community proposal',
            }),
          ],
        );
        await client.query(
          `INSERT INTO outbox_event
            (event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
           VALUES ($1,'geodata.import.processing.queued.v1','geodata-worker','import_processing_queue',$2,$3::jsonb,now(),$4)`,
          [
            randomUUID(),
            promotionQueueId,
            JSON.stringify({
              queueId: promotionQueueId,
              importRunId: run.id,
              candidateIds: preprocessed.map(
                (candidate) => candidate.candidateId,
              ),
              targetStatus: 'CANDIDATE',
              requestedBy: promotionActor,
              natsSubject: 'myota.geodata.import.process.v1',
            }),
            randomUUID(),
          ],
        );
      }
      const status = errors.length
        ? 'PREPROCESSED_WITH_ERRORS'
        : 'PREPROCESSED';
      const stats = {
        featureCount,
        preprocessed: candidates.length,
        created: candidates.length,
        updated: 0,
        skipped: 0,
        errors: errors.length,
        disappeared: 0,
        conflationCandidates: candidates.filter(
          (item) => item.possibleDuplicates.length,
        ).length,
      };
      await client.query(
        `UPDATE import_run SET status=$2,stats=$3::jsonb,completed_at=now(),
         heartbeat_at=now(),lease_until=NULL,last_error=NULL WHERE id=$1`,
        [run.id, status, JSON.stringify(stats)],
      );
      await client.query(
        `INSERT INTO outbox_event
          (event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
         VALUES ($1,'geodata.import.preprocessed.v1','geodata-worker','import_run',$2,$3::jsonb,now(),$4)`,
        [
          randomUUID(),
          run.id,
          JSON.stringify({
            importRunId: run.id,
            adapter: run.adapter_code,
            preprocessed,
            created,
            updated: [],
            skipped: [],
            errors,
            disappeared: [],
            conflationCandidates: candidates
              .filter((item) => item.possibleDuplicates.length)
              .map((item) => ({
                ordinal: item.ordinal,
                name: item.name,
                matches: item.possibleDuplicates,
              })),
            manifest: { sourceHash: run.source_hash, featureCount, stats },
          }),
          randomUUID(),
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
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

  private async heartbeat(run: ImportRun) {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await client.query(
        `UPDATE import_run SET heartbeat_at=now(),lease_until=now()+interval '5 minutes'
         WHERE id=$1 AND status='PROCESSING' AND attempt_count=$2`,
        [run.id, run.attempt_count],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private storageClient() {
    if (!this.storage)
      this.storage = new S3Client({
        endpoint:
          process.env.MYOTA_OBJECT_STORAGE_ENDPOINT ?? 'http://seaweedfs:8333',
        region: process.env.MYOTA_OBJECT_STORAGE_REGION ?? 'us-east-1',
        forcePathStyle:
          (process.env.MYOTA_OBJECT_STORAGE_ADDRESSING_STYLE ?? 'path') ===
          'path',
        credentials: {
          accessKeyId:
            process.env.MYOTA_OBJECT_STORAGE_ACCESS_KEY ?? 'myota-s3',
          secretAccessKey:
            process.env.MYOTA_OBJECT_STORAGE_SECRET_KEY ?? 'myota-s3-dev-only',
        },
      });
    return this.storage;
  }
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

function boundedFeatureLimit(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 100_000
    ? parsed
    : 5000;
}
