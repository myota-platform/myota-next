import {
  Inject,
  Injectable,
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';

@Injectable()
export class GeodataRepository {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async listEntities(query: Record<string, unknown>) {
    const filters: string[] = [];
    const values: unknown[] = [];
    const add = (fragment: string, value: unknown) => {
      values.push(value);
      filters.push(fragment.replace('?', `$${values.length}`));
    };
    if (query.programme) add('programme_slug=?', query.programme);
    const statuses = listValues(query.status)
      .flatMap((value) => value.split(','))
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean);
    if (statuses.length && !statuses.includes('ALL'))
      add('lifecycle_status=ANY(?::text[])', statuses);
    if (query.entityType)
      add(
        `EXISTS (SELECT 1 FROM geodata_entity_category c WHERE c.entity_id=geodata_entity.id AND lower(c.category_code)=lower(?))`,
        query.entityType,
      );
    for (const field of ['continent', 'country', 'region', 'province'])
      if (query[field])
        add(`lower(COALESCE(${field},''))=lower(?)`, query[field]);
    if (query.city) {
      values.push(query.city, query.city);
      const first = values.length - 1;
      filters.push(
        `(lower(COALESCE(city,''))=lower($${first}) OR lower(COALESCE(municipality,''))=lower($${first + 1}))`,
      );
    }
    const bounds = parseBounds(query);
    if (bounds) {
      values.push(...bounds);
      const offset = values.length - 3;
      filters.push(
        `geom && ST_MakeEnvelope($${offset},$${offset + 1},$${offset + 2},$${offset + 3},4326)`,
      );
    }
    const where = filters.length ? filters.join(' AND ') : 'true';
    const page = positiveInteger(query.page, 1);
    const pageSize = Math.min(100, positiveInteger(query.pageSize, 50));
    const client = await this.connect();
    try {
      const counted = await client.query(
        `SELECT count(*)::integer AS total FROM geodata_entity WHERE ${where}`,
        values,
      );
      const offset = (page - 1) * pageSize;
      const rows = await client.query(
        `SELECT ${entityProjection} AS entity FROM geodata_entity
         WHERE ${where} ORDER BY lower(name),id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, pageSize, offset],
      );
      const total = Number(counted.rows[0]?.total ?? 0);
      return {
        items: rows.rows.map((row) => row.entity),
        page,
        pageSize,
        total,
        nextPage: page * pageSize < total ? page + 1 : null,
      };
    } finally {
      client.release();
    }
  }

  async getEntity(id: string) {
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT ${entityProjection} AS entity FROM geodata_entity WHERE id=$1`,
        [id],
      );
      if (!result.rows[0])
        throw new NotFoundException('geodata entity not found');
      return result.rows[0].entity;
    } finally {
      client.release();
    }
  }

  async getLocationRows() {
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT DISTINCT jsonb_build_object(
          'continent',continent,'continentCode',continent_code,'country',country,
          'countryCode',country_code,'region',region,'regionCode',region_code,
          'province',province,'provinceCode',province_code,'county',county,
          'city',city,'municipality',municipality) AS location FROM geodata_entity`,
      );
      return result.rows.map(
        (row) => row.location as Record<string, string | null>,
      );
    } finally {
      client.release();
    }
  }

  async listImports(query: Record<string, unknown>) {
    const page = positiveInteger(query.page, 1);
    const pageSize = Math.min(100, positiveInteger(query.pageSize, 50));
    const client = await this.connect();
    try {
      const counted = await client.query(
        'SELECT count(*)::integer AS total FROM import_run',
      );
      const rows = await client.query(
        `SELECT ${importProjection} AS run FROM import_run ORDER BY started_at DESC,id LIMIT $1 OFFSET $2`,
        [pageSize, (page - 1) * pageSize],
      );
      const total = Number(counted.rows[0]?.total ?? 0);
      return {
        items: rows.rows.map((row) => row.run),
        page,
        pageSize,
        total,
        nextPage: page * pageSize < total ? page + 1 : null,
      };
    } finally {
      client.release();
    }
  }

  async getImport(id: string) {
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT ${importProjection} AS run FROM import_run WHERE id=$1`,
        [id],
      );
      if (!result.rows[0])
        throw new NotFoundException('geodata import not found');
      return result.rows[0].run;
    } finally {
      client.release();
    }
  }

  async listImportCandidates(runId: string, query: Record<string, unknown>) {
    const page = positiveInteger(query.page, 1);
    const pageSize = Math.min(100, positiveInteger(query.pageSize, 50));
    const client = await this.connect();
    try {
      const counted = await client.query(
        "SELECT count(*)::integer AS total FROM geodata_import_candidate WHERE import_run_id=$1 AND validation_status='PENDING'",
        [runId],
      );
      const result = await client.query(
        `SELECT ${candidateProjection} AS candidate
         FROM geodata_import_candidate WHERE import_run_id=$1 AND validation_status='PENDING'
         ORDER BY ordinal,id LIMIT $2 OFFSET $3`,
        [runId, pageSize, (page - 1) * pageSize],
      );
      const total = Number(counted.rows[0]?.total ?? 0);
      return {
        items: result.rows.map((row) => row.candidate),
        page,
        pageSize,
        total,
        nextPage: page * pageSize < total ? page + 1 : null,
      };
    } finally {
      client.release();
    }
  }

  async validateImportCandidates(
    runId: string,
    key: string | undefined,
    body: Record<string, unknown>,
  ) {
    const candidateIds = body.candidateIds;
    const reviewerId =
      typeof body.reviewerId === 'string' ? body.reviewerId.trim() : '';
    if (
      !Array.isArray(candidateIds) ||
      !candidateIds.length ||
      candidateIds.some((id) => typeof id !== 'string' || !isUuid(id))
    )
      throw new BadRequestException(
        'candidateIds must be a non-empty list of UUIDs',
      );
    if (new Set(candidateIds).size !== candidateIds.length)
      throw new BadRequestException('candidateIds must be unique');
    if (!reviewerId) throw new BadRequestException('reviewerId is required');
    const requested =
      typeof body.validationStatus === 'string'
        ? body.validationStatus.toUpperCase()
        : 'VALID';
    if (!['VALID', 'CONFIRMED', 'REJECTED', 'INVALID'].includes(requested))
      throw new BadRequestException(
        'validationStatus must be VALID or REJECTED',
      );
    const rejected = requested === 'REJECTED' || requested === 'INVALID';
    const note =
      typeof body.note === 'string' ? body.note.slice(0, 2000) : null;
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      if (key) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('geodata-candidate-validation:' || $1,0))",
          [key],
        );
        const previous = await client.query(
          'SELECT response FROM idempotency_record WHERE service=$1 AND key=$2',
          ['geodata-candidate-validation', key],
        );
        if (previous.rows[0]) {
          await client.query('COMMIT');
          return previous.rows[0].response;
        }
      }
      const selected = await client.query(
        `SELECT id,validation_status,processing_queue_id
         FROM geodata_import_candidate WHERE import_run_id=$1 AND id=ANY($2::uuid[])
         FOR UPDATE`,
        [runId, candidateIds],
      );
      if (selected.rows.length !== candidateIds.length)
        throw new BadRequestException(
          'one or more candidates do not belong to this import run',
        );
      if (rejected && selected.rows.some((row) => row.processing_queue_id))
        throw new BadRequestException('queued candidates cannot be rejected');

      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      if (rejected) {
        await client.query(
          'DELETE FROM geodata_import_candidate WHERE import_run_id=$1 AND id=ANY($2::uuid[])',
          [runId, candidateIds],
        );
      } else {
        await client.query(
          `UPDATE geodata_import_candidate SET validation_status='CONFIRMED',
           validation_note=$3,validated_by=$4,validated_at=now(),updated_at=now()
           WHERE import_run_id=$1 AND id=ANY($2::uuid[]) AND validation_status<>'PROCESSED'`,
          [runId, candidateIds, note, reviewerId],
        );
      }
      const eventType = rejected
        ? 'geodata.import.candidates.rejected.v1'
        : 'geodata.import.candidates.validated.v1';
      await client.query(
        `INSERT INTO outbox_event
         (event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
         VALUES ($1,$2,'geodata-service','import_run',$3,$4::jsonb,now(),$5)`,
        [
          randomUUID(),
          eventType,
          runId,
          JSON.stringify({ importRunId: runId, candidateIds, reviewerId }),
          randomUUID(),
        ],
      );
      const response = {
        importRunId: runId,
        candidateIds,
        validationStatus: rejected ? 'REJECTED' : 'CONFIRMED',
      };
      if (key)
        await client.query(
          'INSERT INTO idempotency_record(service,key,response) VALUES ($1,$2,$3::jsonb)',
          ['geodata-candidate-validation', key, JSON.stringify(response)],
        );
      await client.query('COMMIT');
      return response;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getEntityAudit(id: string) {
    const entity = await this.getEntity(id);
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT event FROM geodata_audit_event
         WHERE aggregate_type='entity' AND aggregate_id=$1
         ORDER BY occurred_at,event_id`,
        [id],
      );
      return {
        entityId: entity.id,
        status: entity.status,
        reviewHistory: entity.reviewHistory ?? [],
        geometryHistory: entity.geometryHistory ?? [],
        events: result.rows.map((row) => row.event),
      };
    } finally {
      client.release();
    }
  }

  async getTile(zoom: number, x: number, y: number) {
    if (
      !Number.isInteger(zoom) ||
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      zoom < 0 ||
      zoom > 22 ||
      x < 0 ||
      y < 0 ||
      x >= 2 ** zoom ||
      y >= 2 ** zoom
    )
      throw new BadRequestException(
        'tile coordinates are outside the valid range',
      );
    const client = await this.connect();
    try {
      const result = await client.query(
        `WITH bounds AS (SELECT ST_TileEnvelope($1,$2,$3) AS geom),
         tile_features AS (
           SELECT e.id,e.name,e.lifecycle_status AS status,e.programme_slug,
             e.entity_type_code,ST_AsMVTGeom(ST_Transform(e.geom,3857),bounds.geom) AS geom
           FROM geodata_entity e CROSS JOIN bounds
           WHERE e.lifecycle_status='APPROVED'
             AND ST_Transform(e.geom,3857) && bounds.geom
         )
         SELECT ST_AsMVT(tile_features,'geodata',4096,'geom') AS tile FROM tile_features`,
        [zoom, x, y],
      );
      return result.rows[0]?.tile
        ? Buffer.from(result.rows[0].tile)
        : Buffer.alloc(0);
    } finally {
      client.release();
    }
  }

  private async connect() {
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

const entityProjection = `public_properties || jsonb_build_object(
  'id',id::text,'programmeSlug',programme_slug,'entityType',entity_type_code,
  'name',name,'website',website,'description',description,'status',lifecycle_status,
  'geometry',ST_AsGeoJSON(geom)::jsonb,
  'centroid',jsonb_build_object('lon',ST_X(COALESCE(centroid,ST_Centroid(geom)::geography)::geometry),'lat',ST_Y(COALESCE(centroid,ST_Centroid(geom)::geography)::geometry)),
  'maidenheadGridSquares4',maidenhead_grid_squares_4,'maidenheadLocators6',maidenhead_locators_6,
  'sourceState',source_state,'jurisdiction',jurisdiction,'attachments',attachments,'version',revision,
  'categories',COALESCE((SELECT jsonb_agg(category_code ORDER BY category_code) FROM geodata_entity_category c WHERE c.entity_id=geodata_entity.id),'[]'::jsonb),
  'location',jsonb_build_object('continent',continent,'country',country,'region',region,'province',province,'county',county,'city',city,'municipality',municipality,'locality',locality)
)`;

const importProjection = `source_metadata || jsonb_build_object(
  'id',id::text,'adapter',adapter_code,'status',status,'startedAt',started_at,
  'completedAt',completed_at,'stats',stats,'attemptCount',attempt_count,
  'heartbeatAt',heartbeat_at,'leaseUntil',lease_until,'lastError',last_error,
  'processedAt',processed_at,'processedBy',processed_by,
  'cancellationRequestedAt',cancellation_requested_at,
  'cancellationRequestedBy',cancellation_requested_by,
  'candidateCounts',(SELECT jsonb_build_object(
    'total',count(*),'duplicates',count(*) FILTER (WHERE jsonb_array_length(COALESCE(entity_payload->'possibleDuplicates','[]'::jsonb))>0),
    'pending',count(*) FILTER (WHERE validation_status='PENDING'),
    'confirmed',count(*) FILTER (WHERE validation_status='CONFIRMED'),
    'processed',count(*) FILTER (WHERE validation_status='PROCESSED'),
    'rejected',count(*) FILTER (WHERE validation_status='REJECTED'))
    FROM geodata_import_candidate c WHERE c.import_run_id=import_run.id)
)`;

const candidateProjection = `jsonb_build_object(
  'id',id::text,'importRunId',import_run_id::text,'ordinal',ordinal,
  'existingEntityId',existing_entity_id,'name',name,'entityTypes',entity_type_codes,
  'geometry',ST_AsGeoJSON(geom)::jsonb,
  'centroid',jsonb_build_object('lon',ST_X(ST_Centroid(geom)),'lat',ST_Y(ST_Centroid(geom))),
  'sourceRef',source_ref,'candidateSource',candidate_source,
  'dedupeWarning',CASE WHEN jsonb_array_length(COALESCE(entity_payload->'possibleDuplicates','[]'::jsonb))>0 THEN 'POSSIBLE_DUPLICATE' ELSE NULL END,
  'possibleDuplicates',COALESCE(entity_payload->'possibleDuplicates','[]'::jsonb),
  'validationStatus',validation_status,'validationNote',validation_note,
  'validatedBy',validated_by,'validatedAt',validated_at,'targetStatus',target_status,
  'processedEntityId',processed_entity_id,'processedAt',processed_at,
  'location',jsonb_build_object(
    'continent',entity_payload->'continent','country',entity_payload->'country',
    'region',entity_payload->'region','province',entity_payload->'province',
    'county',entity_payload->'county','city',entity_payload->'city',
    'municipality',entity_payload->'municipality','locality',entity_payload->'locality'))`;

function listValues(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : typeof value === 'string'
      ? [value]
      : [];
}

function positiveInteger(value: unknown, fallback: number) {
  const number = Number.parseInt(typeof value === 'string' ? value : '', 10);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function parseBounds(query: Record<string, unknown>) {
  let raw: number[];
  if (typeof query.bbox === 'string' && query.bbox) {
    raw = query.bbox.split(',').map(Number);
  } else {
    const names = ['minLon', 'minLat', 'maxLon', 'maxLat'];
    if (!names.some((name) => query[name] !== undefined)) return null;
    raw = names.map((name) => Number(query[name]));
  }
  if (
    raw.length !== 4 ||
    raw.some((value) => !Number.isFinite(value)) ||
    raw[0] < -180 ||
    raw[0] >= raw[2] ||
    raw[2] > 180 ||
    raw[1] < -90 ||
    raw[1] >= raw[3] ||
    raw[3] > 90
  )
    throw new BadRequestException(
      'map bounds must have minimum values below maximum values',
    );
  return raw;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
