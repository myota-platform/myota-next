import {
  Inject,
  Injectable,
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Pool } from 'pg';
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
