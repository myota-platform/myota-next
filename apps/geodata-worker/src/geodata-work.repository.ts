import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
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
import { parsePageTotal } from '@app/platform/pagination.js';
import {
  MAX_IMPORT_BATCH_BYTES,
  MAX_IMPORT_BATCH_FEATURES,
  MAX_IMPORT_FEATURE_BYTES,
  MAX_IMPORT_FEATURES,
  IMPORT_RUN_LEASE_SECONDS,
} from '@app/platform/import-limits.js';
import { pythonFloatString } from '@app/platform/python-number.js';
import {
  canonicalPythonGeoJsonFeature,
  canonicalPythonGeneratedJson,
  canonicalPythonJson,
  canonicalPythonJsonWithProperty,
} from '../../geodata/src/geodata-request-fingerprint.js';
import {
  firstPythonTruthy,
  pythonTruthy,
} from '@app/platform/python-truthiness.js';
import { comparePythonStrings } from '@app/platform/python-string.js';
import { streamShapefileFeatures } from './geodata-shapefile-stream.js';
import {
  readGeoJsonDocumentMetadata,
  sourceHashOverrideForGeoJsonFeature,
  sourceJsonForGeoJsonFeature,
  streamGeoJsonFeatures,
} from './geodata-geojson-stream.js';
import { decodeOsmPbfStream } from './geodata-osm-pbf.js';
import { normalizeAdapterFeature } from './geodata-adapter.js';

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
  candidateId: string;
  ordinal: number;
  name: string;
  geometry: string;
  properties: Record<string, unknown>;
  sourceRef: string | null;
  sourceHash: string;
  possibleDuplicates: Record<string, unknown>[];
}

type StagedImportRecord =
  | { ordinal: number; candidate: PreparedCandidate }
  | { ordinal: number; error: Record<string, unknown> }
  | { ordinal: number; skipped: Record<string, unknown> };

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
          'DELETE FROM geodata_import_candidate_stage WHERE import_run_id=$1',
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
            stringifyJsonWithBigInts({ importRunId: pendingCancellation.id }),
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
        'DELETE FROM geodata_import_candidate_stage WHERE import_run_id=$1',
        [row.id],
      );
      await client.query(
        `UPDATE import_run SET status='PROCESSING',attempt_count=attempt_count+1,
         heartbeat_at=now(),lease_until=now()+make_interval(secs=>$2),last_error=NULL
         WHERE id=$1`,
        [row.id, IMPORT_RUN_LEASE_SECONDS],
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
        stringifyJsonWithBigInts(payload),
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
          stringifyJsonWithBigInts(envelope),
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
    const format =
      typeof run.source_metadata.format === 'string'
        ? run.source_metadata.format.toUpperCase()
        : 'GEOJSON';
    const filename =
      typeof run.source_metadata.filename === 'string'
        ? run.source_metadata.filename
        : '';
    const featureLimit = MAX_IMPORT_FEATURES;
    let features: Iterable<unknown> | AsyncIterable<unknown>;
    if (format === 'OSM_PBF') {
      features = decodeOsmPbfStream(
        object.Body as AsyncIterable<Uint8Array>,
        filename,
        featureLimit,
        run.source_hash,
      );
    } else if (format === 'GEOJSON') {
      const documentMetadata = await readGeoJsonDocumentMetadata(
        object.Body as AsyncIterable<Uint8Array>,
        () => this.heartbeat(run),
      );
      const replay = await this.storageClient().send(
        new GetObjectCommand({ Bucket: bucket, Key: run.source_key }),
      );
      if (!replay.Body)
        throw new Error('geodata import source object has no content');
      features = streamGeoJsonFeatures(
        replay.Body as AsyncIterable<Uint8Array>,
        run.source_hash,
        featureLimit,
        {
          ...documentMetadata,
          sourceFeatureHashOverrides: Array.isArray(
            run.source_metadata.sourceFeatureHashOverrides,
          )
            ? run.source_metadata.sourceFeatureHashOverrides
            : undefined,
        },
        () => this.heartbeat(run),
      );
    } else if (format === 'SHAPEFILE' || format === 'SHP') {
      features = streamShapefileFeatures(
        object.Body as AsyncIterable<Uint8Array>,
        filename,
        run.source_hash,
        featureLimit,
        () => this.heartbeat(run),
      );
    } else {
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
      const document: unknown = JSON.parse(raw.toString('utf8'));
      if (
        !isRecord(document) ||
        document.type !== 'FeatureCollection' ||
        !Array.isArray(document.features)
      )
        throw new Error('stored source is not a supported FeatureCollection');
      if (document.features.length > featureLimit)
        throw new Error(
          `geodata import contains more than ${featureLimit} features`,
        );
      features = document.features;
    }

    const staged: StagedImportRecord[] = [];
    let stagedBytes = 0;
    const flushStaged = async () => {
      if (!staged.length) return;
      await this.stageFeatures(run, staged);
      staged.length = 0;
      stagedBytes = 0;
    };
    const source = isRecord(run.source_metadata.source)
      ? run.source_metadata.source
      : {};
    const sourceKey = sourceKeyFromMetadata(source);
    let featureCount = 0;
    for await (const feature of features) {
      const featureBytes = Buffer.byteLength(
        canonicalPythonGeneratedJson(feature, () => true),
        'utf8',
      );
      if (
        staged.length > 0 &&
        (staged.length >= MAX_IMPORT_BATCH_FEATURES ||
          stagedBytes + featureBytes > MAX_IMPORT_BATCH_BYTES)
      )
        await flushStaged();
      const ordinal = featureCount;
      featureCount += 1;
      if (featureCount > featureLimit)
        throw new Error(
          `geodata import contains more than ${featureLimit} features`,
        );
      if (ordinal > 0 && ordinal % 100 === 0) await this.heartbeat(run);

      let record: StagedImportRecord;
      try {
        if (!isRecord(feature)) throw new Error('feature must be an object');
        const sourceJson = sourceJsonForGeoJsonFeature(feature);
        const sourceHash =
          sourceHashOverrideForGeoJsonFeature(feature) ??
          hashCanonicalJson(feature, sourceJson);
        const normalized = normalizeAdapterFeature(run.adapter_code, feature);
        const properties = normalized.properties;
        const sourceRefCandidate = firstPythonTruthy(
          properties.sourceRef,
          properties.id,
          properties['@id'],
          feature.id,
        );
        const sourceRef = resolveLegacyManualSourceRef(
          !pythonTruthy(sourceRefCandidate)
            ? `${sourceKey}:import-${run.id}:record-${ordinal}`
            : pythonSourceRef(sourceRefCandidate),
          feature,
          run.adapter_code,
          sourceKey,
          run.id,
          ordinal,
        );
        if (normalized.skipReason) {
          record = {
            ordinal,
            skipped: {
              sourceRef,
              reason: normalized.skipReason,
            },
          };
        } else if (!normalized.geometry) {
          record = {
            ordinal,
            skipped: {
              sourceRef,
              reason: 'MISSING_GEOMETRY',
            },
          };
        } else {
          const name =
            typeof properties.name === 'string'
              ? properties.name
              : 'Unnamed candidate';
          const geometry = stringifyJsonWithBigInts(normalized.geometry);
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
              record = {
                ordinal,
                error: {
                  ordinal,
                  message:
                    'geometry is empty, invalid, or outside WGS84 bounds',
                },
              };
            } else {
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
              record = {
                ordinal,
                candidate: {
                  candidateId: randomUUID(),
                  ordinal,
                  name,
                  geometry,
                  properties,
                  sourceRef,
                  sourceHash,
                  possibleDuplicates: duplicates.rows.map((duplicate) => ({
                    entityId: duplicate.id,
                    name: duplicate.name,
                    status: duplicate.status,
                    entityTypes: duplicate.entity_type
                      ? [duplicate.entity_type]
                      : [],
                    geometry: duplicate.geometry,
                    distanceMeters: Number(duplicate.distance_meters),
                    matchType: duplicate.match_type,
                  })),
                },
              };
            }
          } finally {
            client.release();
          }
        }
      } catch (error) {
        record = {
          ordinal,
          error: {
            ordinal,
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
      staged.push(record);
      stagedBytes += featureBytes;
      if (
        staged.length >= MAX_IMPORT_BATCH_FEATURES ||
        stagedBytes >= MAX_IMPORT_BATCH_BYTES
      )
        await flushStaged();
    }
    await flushStaged();
    await this.saveCandidates(run, featureCount);
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
          'DELETE FROM geodata_import_candidate_stage WHERE import_run_id=$1',
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
            stringifyJsonWithBigInts({ importRunId: run.id }),
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
      if (exhausted)
        await client.query(
          'DELETE FROM geodata_import_candidate_stage WHERE import_run_id=$1',
          [run.id],
        );
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
        'DELETE FROM geodata_import_candidate_stage WHERE import_run_id=$1',
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
          stringifyJsonWithBigInts({ importRunId: run.id }),
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

  private async stageFeatures(run: ImportRun, records: StagedImportRecord[]) {
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
      for (const record of records) {
        if ('candidate' in record) {
          await client.query(
            `INSERT INTO geodata_import_candidate_stage
              (import_run_id,attempt_count,ordinal,candidate_id,candidate_payload)
             VALUES ($1,$2,$3,$4,$5::jsonb)`,
            [
              run.id,
              run.attempt_count,
              record.ordinal,
              record.candidate.candidateId,
              canonicalPythonGeneratedJson(record.candidate, () => false),
            ],
          );
        } else if ('skipped' in record) {
          await client.query(
            `INSERT INTO geodata_import_candidate_stage
              (import_run_id,attempt_count,ordinal,skipped_payload)
             VALUES ($1,$2,$3,$4::jsonb)`,
            [
              run.id,
              run.attempt_count,
              record.ordinal,
              stringifyJsonWithBigInts(record.skipped),
            ],
          );
        } else {
          await client.query(
            `INSERT INTO geodata_import_candidate_stage
              (import_run_id,attempt_count,ordinal,error_payload)
             VALUES ($1,$2,$3,$4::jsonb)`,
            [
              run.id,
              run.attempt_count,
              record.ordinal,
              stringifyJsonWithBigInts(record.error),
            ],
          );
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

  private async saveCandidates(run: ImportRun, featureCount: number) {
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
      const stagedCounts = await client.query(
        `SELECT count(*) FILTER (WHERE candidate_id IS NOT NULL) > 0 AS candidates,
                count(*) FILTER (WHERE error_payload IS NOT NULL) > 0 AS errors,
                count(*) FILTER (WHERE skipped_payload IS NOT NULL) > 0 AS skipped
         FROM geodata_import_candidate_stage
         WHERE import_run_id=$1 AND attempt_count=$2`,
        [run.id, run.attempt_count],
      );
      const hasCandidates = stagedCounts.rows[0]?.candidates === true;
      const hasErrors = stagedCounts.rows[0]?.errors === true;
      const hasSkipped = stagedCounts.rows[0]?.skipped === true;
      const promotionQueueId =
        promotionActor &&
        (hasCandidates ||
          (run.complete_snapshot &&
            featureCount === 0 &&
            !hasErrors &&
            !hasSkipped))
          ? randomUUID()
          : null;

      await client.query(
        `INSERT INTO geodata_import_candidate
          (id,import_run_id,ordinal,programme_slug,entity_type_codes,name,geom,
           candidate_source,source_ref,source_hash,provenance,entity_payload)
         SELECT s.candidate_id,$1,s.ordinal,$3,$4::jsonb,
           s.candidate_payload->>'name',
           ST_SetSRID(ST_GeomFromGeoJSON(s.candidate_payload->>'geometry'),4326),
           $5::jsonb,s.candidate_payload->>'sourceRef',
           s.candidate_payload->>'sourceHash',
           jsonb_build_object('adapter',$6,'sourceHash',s.candidate_payload->>'sourceHash'),
           (s.candidate_payload->'properties') || jsonb_build_object(
             'entityType',$4::jsonb->0,'entityTypes',$4::jsonb,
             'entityTypeCodes',$4::jsonb,
             'geometry',(s.candidate_payload->>'geometry')::jsonb,
             'possibleDuplicates',s.candidate_payload->'possibleDuplicates')
         FROM geodata_import_candidate_stage s
         WHERE s.import_run_id=$1 AND s.attempt_count=$2
           AND s.candidate_id IS NOT NULL ORDER BY s.ordinal`,
        [
          run.id,
          run.attempt_count,
          programmeSlug,
          stringifyJsonWithBigInts(entityTypes),
          stringifyJsonWithBigInts(run.source_metadata.source ?? {}),
          run.adapter_code,
        ],
      );
      if (promotionActor && promotionQueueId) {
        await client.query(
          `UPDATE geodata_import_candidate c SET validation_status='CONFIRMED',
             validated_by=$2,validated_at=now(),target_status='CANDIDATE',
             processing_queue_id=$3
           FROM geodata_import_candidate_stage s
           WHERE s.import_run_id=$1 AND s.attempt_count=$4
             AND s.candidate_id=c.id`,
          [run.id, promotionActor, promotionQueueId, run.attempt_count],
        );
        await client.query(
          `INSERT INTO geodata_import_processing_queue
            (id,import_run_id,candidate_ids,target_status,requested_by,status,job_metadata)
           VALUES ($1,$2,
             COALESCE((SELECT jsonb_agg(candidate_id::text ORDER BY ordinal)
               FROM geodata_import_candidate_stage
               WHERE import_run_id=$2 AND attempt_count=$3 AND candidate_id IS NOT NULL),'[]'::jsonb),
             'CANDIDATE',$4,'QUEUED',$5::jsonb)`,
          [
            promotionQueueId,
            run.id,
            run.attempt_count,
            promotionActor,
            stringifyJsonWithBigInts({
              note: textValue(autoPromote?.note) ?? 'Community proposal',
            }),
          ],
        );
        await client.query(
          `INSERT INTO outbox_event
            (event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
           VALUES ($1,'geodata.import.processing.queued.v1','geodata-worker','import_processing_queue',$2,
             jsonb_build_object('queueId',$2::text,'importRunId',$3::text,
               'candidateIds',COALESCE((SELECT jsonb_agg(candidate_id::text ORDER BY ordinal)
                 FROM geodata_import_candidate_stage
                 WHERE import_run_id=$3 AND attempt_count=$4 AND candidate_id IS NOT NULL),'[]'::jsonb),
               'targetStatus','CANDIDATE','requestedBy',$5,
               'natsSubject','myota.geodata.import.process.v1'),now(),$6)`,
          [
            randomUUID(),
            promotionQueueId,
            run.id,
            run.attempt_count,
            promotionActor,
            randomUUID(),
          ],
        );
      }

      const stats = await client.query(
        `SELECT count(*) FILTER (WHERE candidate_id IS NOT NULL) AS preprocessed,
                count(*) FILTER (WHERE error_payload IS NOT NULL) AS errors,
                count(*) FILTER (WHERE skipped_payload IS NOT NULL) AS skipped,
                count(*) FILTER (WHERE candidate_id IS NOT NULL
                  AND candidate_payload->'possibleDuplicates' <> '[]'::jsonb) AS conflation
         FROM geodata_import_candidate_stage
         WHERE import_run_id=$1 AND attempt_count=$2`,
        [run.id, run.attempt_count],
      );
      const preprocessedCount = parsePageTotal(
        stats.rows[0]?.preprocessed ?? '0',
      );
      const errorsCount = parsePageTotal(stats.rows[0]?.errors ?? '0');
      const skippedFeatures = parsePageTotal(stats.rows[0]?.skipped ?? '0');
      const conflationCount = parsePageTotal(stats.rows[0]?.conflation ?? '0');
      const source = isRecord(run.source_metadata.source)
        ? run.source_metadata.source
        : {};
      const sourceKey = sourceKeyFromMetadata(source);
      const manifestSummary = await client.query(
        `WITH source_records AS (
           SELECT DISTINCT ON (source_ref COLLATE "C") source_ref,source_hash,ordinal
           FROM geodata_import_candidate
           WHERE import_run_id=$1 AND source_ref IS NOT NULL
           ORDER BY source_ref COLLATE "C",ordinal DESC
         ), manifest AS (
           SELECT (SELECT count(*) FROM geodata_import_candidate
             WHERE import_run_id=$1 AND source_ref IS NOT NULL) AS record_count,
             encode(public.digest(convert_to('{' || COALESCE(string_agg(
               to_json(source_ref)::text || ':' || to_json(source_hash)::text,
               ',' ORDER BY source_ref COLLATE "C"), '') || '}', 'UTF8'), 'sha256'), 'hex') AS source_hash
           FROM source_records
         )
         SELECT manifest.record_count,manifest.source_hash,
           NOT EXISTS (SELECT 1 FROM source_snapshot_manifest previous
             WHERE previous.source_key=$2 AND previous.adapter_code=$3
               AND previous.source_hash=manifest.source_hash) AS source_changed
         FROM manifest`,
        [run.id, sourceKey, run.adapter_code],
      );
      const manifestRecordCount = parsePageTotal(
        manifestSummary.rows[0]?.record_count ?? '0',
      );
      const manifestSourceHash = String(
        manifestSummary.rows[0]?.source_hash ?? '',
      );
      const sourceChanged = Boolean(manifestSummary.rows[0]?.source_changed);
      const manifestId = randomUUID();
      await client.query(
        `INSERT INTO source_snapshot_manifest
          (id,import_run_id,source_key,adapter_code,source_hash,record_count,source_metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [
          manifestId,
          run.id,
          sourceKey,
          run.adapter_code,
          manifestSourceHash,
          manifestRecordCount,
          stringifyJsonWithBigInts(source),
        ],
      );
      await client.query(
        `WITH source_records AS (
           SELECT DISTINCT ON (source_ref COLLATE "C") source_ref,source_hash,ordinal
           FROM geodata_import_candidate
           WHERE import_run_id=$1 AND source_ref IS NOT NULL
           ORDER BY source_ref COLLATE "C",ordinal DESC
         )
         INSERT INTO source_snapshot_record(manifest_id,source_record_id,record_hash)
         SELECT $2,source_ref,COALESCE(source_hash,'') FROM source_records
         ON CONFLICT (manifest_id,source_record_id) DO NOTHING`,
        [run.id, manifestId],
      );
      const disappearedIds = run.complete_snapshot
        ? await this.reconcileSnapshot(client, run, manifestId)
        : [];
      const status = errorsCount ? 'PREPROCESSED_WITH_ERRORS' : 'PREPROCESSED';
      const statsPayload = {
        featureCount,
        preprocessed: preprocessedCount,
        created: 0,
        updated: 0,
        skipped: skippedFeatures,
        errors: errorsCount,
        disappeared: disappearedIds.length,
        conflationCandidates: conflationCount,
      };
      await client.query(
        `UPDATE import_run SET status=$2,stats=$3::jsonb,completed_at=now(),
         heartbeat_at=now(),lease_until=NULL,last_error=NULL WHERE id=$1`,
        [run.id, status, stringifyJsonWithBigInts(statsPayload)],
      );

      const preprocessedCandidates = `COALESCE((SELECT jsonb_agg(candidate_id::text ORDER BY ordinal)
        FROM geodata_import_candidate_stage
        WHERE import_run_id=$2 AND attempt_count=$3 AND candidate_id IS NOT NULL),'[]'::jsonb)`;
      const errorSummaries = `COALESCE((SELECT jsonb_agg(error_payload ORDER BY ordinal)
        FROM geodata_import_candidate_stage
        WHERE import_run_id=$2 AND attempt_count=$3 AND error_payload IS NOT NULL),'[]'::jsonb)`;
      const skippedSummaries = `COALESCE((SELECT jsonb_agg(skipped_payload ORDER BY ordinal)
        FROM geodata_import_candidate_stage
        WHERE import_run_id=$2 AND attempt_count=$3 AND skipped_payload IS NOT NULL),'[]'::jsonb)`;
      const conflationSummaries = `COALESCE((SELECT jsonb_agg(
        jsonb_build_object('ordinal',ordinal,'name',candidate_payload->>'name',
          'matches',candidate_payload->'possibleDuplicates') ORDER BY ordinal)
        FROM geodata_import_candidate_stage
        WHERE import_run_id=$2 AND attempt_count=$3 AND candidate_id IS NOT NULL
          AND candidate_payload->'possibleDuplicates' <> '[]'::jsonb),'[]'::jsonb)`;
      const sourceRecordMap = `COALESCE((SELECT jsonb_object_agg(source_ref,source_hash)
        FROM (SELECT DISTINCT ON (source_ref COLLATE "C") source_ref,source_hash
          FROM geodata_import_candidate WHERE import_run_id=$2 AND source_ref IS NOT NULL
          ORDER BY source_ref COLLATE "C",ordinal DESC) records),'{}'::jsonb)`;
      await client.query(
        `INSERT INTO outbox_event
          (event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
         VALUES ($1,'geodata.import.preprocessed.v1','geodata-worker','import_run',$2,
           jsonb_build_object('importRunId',$2::text,'adapter',$4,
             'preprocessed',${preprocessedCandidates},'created','[]'::jsonb,
             'updated','[]'::jsonb,'skipped',${skippedSummaries},
             'errors',${errorSummaries},'disappeared',$12::jsonb,
             'conflationCandidates',${conflationSummaries},
             'manifest',jsonb_build_object('runId',$2::text,'adapter',$4,
               'source',$5::jsonb,'sourceHash',$6,'recordCount',$7::bigint,
               'records',${sourceRecordMap},
               'retrievedAt',$5::jsonb->>'retrievedAt',
               'license',$5::jsonb->>'license',
               'attribution',$5::jsonb->>'attribution',
               'sourceChanged',$8,'featureCount',$9,'stats',$10::jsonb)),now(),$11)`,
        [
          randomUUID(),
          run.id,
          run.attempt_count,
          run.adapter_code,
          stringifyJsonWithBigInts(source),
          manifestSourceHash,
          manifestRecordCount,
          sourceChanged,
          featureCount,
          stringifyJsonWithBigInts(statsPayload),
          randomUUID(),
          stringifyJsonWithBigInts(disappearedIds),
        ],
      );
      await client.query(
        `DELETE FROM geodata_import_candidate_stage
         WHERE import_run_id=$1 AND attempt_count=$2`,
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

  private async reconcileSnapshot(
    client: PoolClient,
    run: ImportRun,
    manifestId: string,
  ): Promise<string[]> {
    const requestedPolicy = Object.hasOwn(
      run.source_metadata,
      'disappearancePolicy',
    )
      ? run.source_metadata.disappearancePolicy
      : 'REVIEW_REQUIRED';
    if (
      typeof requestedPolicy !== 'string' ||
      !['UNCHANGED', 'STALE', 'RETIRED', 'REVIEW_REQUIRED'].includes(
        requestedPolicy,
      )
    )
      throw new Error(
        'disappearancePolicy must be UNCHANGED, STALE, RETIRED, or REVIEW_REQUIRED',
      );
    const policy = requestedPolicy;
    const source = isRecord(run.source_metadata.source)
      ? run.source_metadata.source
      : {};
    const sourceKey = sourceKeyFromMetadata(source);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('geodata-snapshot:' || $1 || ':' || $2,0))",
      [sourceKey, run.adapter_code],
    );
    if (policy === 'UNCHANGED') {
      await this.markSnapshotReconciled(client, run.id, manifestId);
      return [];
    }
    const missing = await client.query(
      `SELECT e.id::text,e.lifecycle_status
         FROM geodata_entity e
        WHERE e.programme_slug IS NOT DISTINCT FROM $1
          AND e.source_key=$3
          AND EXISTS (
            SELECT 1 FROM source_reference r
             WHERE r.entity_id=e.id AND r.adapter_code=$2
               AND r.source_record_id IS NOT NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM source_reference r
            JOIN source_snapshot_record sr
              ON sr.source_record_id=r.source_record_id
             WHERE r.entity_id=e.id AND r.adapter_code=$2
               AND sr.manifest_id=$4
          )
        ORDER BY e.id
        FOR UPDATE OF e`,
      [
        textValue(run.source_metadata.programmeSlug),
        run.adapter_code,
        sourceKey,
        manifestId,
      ],
    );
    const disappearedIds: string[] = [];
    for (const row of missing.rows as Array<{
      id: string;
      lifecycle_status: string;
    }>) {
      const occurredAt = new Date().toISOString();
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
      await client.query(
        `INSERT INTO outbox_event
          (event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
         VALUES ($1,'geodata.entity.source-disappeared.v1','geodata-worker',
           'entity',$2,$3::jsonb,$4,$5)`,
        [
          randomUUID(),
          row.id,
          stringifyJsonWithBigInts({
            entityId: row.id,
            policy,
            previousStatus: row.lifecycle_status,
          }),
          occurredAt,
          randomUUID(),
        ],
      );
      disappearedIds.push(row.id);
    }
    await this.markSnapshotReconciled(client, run.id, manifestId);
    return disappearedIds;
  }

  private async markSnapshotReconciled(
    client: PoolClient,
    runId: string,
    manifestId: string,
  ): Promise<void> {
    const reconciledAt = new Date().toISOString();
    await client.query(
      `UPDATE import_run SET source_metadata=source_metadata || jsonb_build_object(
        'snapshotReconciledAt',$2::text,'sourceSnapshotManifestId',$3::text
       ) WHERE id=$1`,
      [runId, reconciledAt, manifestId],
    );
  }

  async heartbeat(run: ImportRun): Promise<void> {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      const renewed = await client.query(
        `UPDATE import_run SET heartbeat_at=now(),lease_until=now()+make_interval(secs=>$3)
         WHERE id=$1 AND status='PROCESSING' AND attempt_count=$2
         RETURNING id`,
        [run.id, run.attempt_count, IMPORT_RUN_LEASE_SECONDS],
      );
      if (!renewed.rowCount)
        throw new Error(
          'geodata import lease was superseded or cancellation was requested',
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

function sourceKeyFromMetadata(source: Record<string, unknown>): string {
  const value = firstPythonTruthy(source.sourceKey, source.url, source.name);
  if (value === undefined) return 'unknown-source';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return stringifyJsonWithBigInts(value) ?? '';
  if (typeof value === 'number' || typeof value === 'bigint')
    return value.toString();
  return '';
}

function pythonSourceRef(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint')
    return String(value);
  return stringifyJsonWithBigInts(value) ?? String(value);
}

function resolveLegacyManualSourceRef(
  sourceRef: string,
  feature: Record<string, unknown>,
  adapter: string,
  sourceKey: string,
  runId: string,
  ordinal: number,
): string {
  const legacyPattern = /^MANUAL:record-\d+$/i;
  if (adapter !== 'MANUAL' || !legacyPattern.test(sourceRef)) return sourceRef;
  const properties = isRecord(feature.properties) ? feature.properties : {};
  for (const value of [
    properties.sourceRef,
    properties['@id'],
    properties.id,
    feature.id,
  ]) {
    if (!pythonTruthy(value)) continue;
    const stableSourceRef = pythonSourceRef(value);
    if (!legacyPattern.test(stableSourceRef)) return stableSourceRef;
  }
  return `${sourceKey}:import-${runId}:record-${ordinal}`;
}

function hashCanonicalJson(
  value: unknown,
  sourceJson?: {
    rawJson: string;
    inheritedCrsJson?: string;
    rootGeometryDocument?: boolean;
  },
): string {
  if (sourceJson !== undefined) {
    const canonical = sourceJson.rootGeometryDocument
      ? canonicalPythonGeoJsonFeature(
          sourceJson.rawJson,
          sourceJson.inheritedCrsJson,
        )
      : sourceJson.inheritedCrsJson === undefined
        ? canonicalPythonJson(sourceJson.rawJson)
        : canonicalPythonJsonWithProperty(
            sourceJson.rawJson,
            'crs',
            sourceJson.inheritedCrsJson,
          );
    if (Buffer.byteLength(canonical, 'utf8') > MAX_IMPORT_FEATURE_BYTES)
      throw new Error(
        `a source feature exceeds the configured decoded-size limit (${MAX_IMPORT_FEATURE_BYTES} bytes)`,
      );
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  }
  const canonical = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    if (item === null) return 'null';
    if (typeof item === 'string') return stringifyJsonWithBigInts(item);
    if (typeof item === 'boolean') return item ? 'true' : 'false';
    if (typeof item === 'number')
      return Number.isInteger(item) && !Object.is(item, -0)
        ? String(item)
        : pythonFloatString(item);
    if (isRecord(item))
      return `{${Object.keys(item)
        .sort(comparePythonStrings)
        .map(
          (key) => `${stringifyJsonWithBigInts(key)}:${canonical(item[key])}`,
        )
        .join(',')}}`;
    return 'null';
  };
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}
