import {
  Inject,
  Injectable,
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import {
  nextPageIfMore,
  pageOffset,
  parsePageInteger,
  parsePageTotal,
} from '@app/platform/pagination.js';
import { firstQueryValue } from '@app/platform/query.js';
import { parseJsonWithExactIntegers } from '@app/platform/json-exact.js';
import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import {
  pythonKeyErrorDetail,
  trimPythonWhitespace,
} from '@app/platform/python-strings.js';
import { parsePythonFloatText } from '@app/platform/python-numeric.js';
import { pythonTruthy } from '@app/platform/python-truthiness.js';
import { canonicalPythonGeneratedJson } from './geodata-request-fingerprint.js';
import { GeodataQueryMetrics } from './geodata-query-metrics.service.js';

export function mapSimplificationToleranceMeters(zoom: number): number {
  return Math.max(0.05, (156543.03392804097 / 2 ** zoom) * 0.65);
}

@Injectable()
export class GeodataRepository {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
    private readonly queryMetrics: GeodataQueryMetrics,
  ) {}

  async listEntities(query: Record<string, unknown>) {
    const filters: string[] = [];
    const values: unknown[] = [];
    const add = (fragment: string, value: unknown) => {
      values.push(value);
      filters.push(fragment.replace('?', `$${values.length}`));
    };
    const programme = firstQueryValue(query.programme);
    const programmeUnassigned = firstQueryValue(
      query.programmeUnassigned,
    )?.toLowerCase();
    if (
      programmeUnassigned !== undefined &&
      programmeUnassigned !== 'true' &&
      programmeUnassigned !== 'false'
    ) {
      throw new BadRequestException(
        'programmeUnassigned must be true or false',
      );
    }
    if (programmeUnassigned === 'true') {
      if (programme)
        throw new BadRequestException(
          'programme and programmeUnassigned cannot be combined',
        );
      filters.push('programme_slug IS NULL');
    } else if (programme) {
      add('programme_slug=?', programme);
    }
    const statuses = listValues(query.status)
      .flatMap((value) => value.split(','))
      .map((value) => trimPythonWhitespace(value).toUpperCase())
      .filter(Boolean);
    if (statuses.length && !statuses.includes('ALL'))
      add('lifecycle_status=ANY(?::text[])', statuses);
    const entityType = firstQueryValue(query.entityType);
    if (entityType)
      add(
        `EXISTS (SELECT 1 FROM geodata_entity_category c WHERE c.entity_id=geodata_entity.id AND lower(c.category_code)=lower(?))`,
        entityType,
      );
    for (const field of [
      'continent',
      'country',
      'region',
      'province',
      'county',
      'locality',
    ]) {
      const value = firstQueryValue(query[field]);
      if (value) add(`lower(COALESCE(${field},''))=lower(?)`, value);
    }
    const city = firstQueryValue(query.city);
    if (city) {
      values.push(city, city);
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
    const page = parsePageInteger(query.page, 1);
    const pageSize = parsePageInteger(query.pageSize, 50, 100);
    const client = await this.connect();
    try {
      const counted = await client.query(
        `SELECT count(*) AS total FROM geodata_entity WHERE ${where}`,
        values,
      );
      const offset = pageOffset(page, pageSize);
      const rows = await client.query(
        `SELECT ${entityProjection} AS entity FROM geodata_entity
         WHERE ${where} ORDER BY lower(name),id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, pageSize, offset],
      );
      const total = parsePageTotal(counted.rows[0]?.total ?? '0');
      return {
        items: rows.rows.map((row) => row.entity),
        page,
        pageSize,
        total,
        nextPage: nextPageIfMore(page, pageSize, total),
      };
    } finally {
      client.release();
    }
  }

  async getAdminMapEntities(query: Record<string, unknown>) {
    const bounds = parseBounds(query);
    if (!bounds)
      throw new BadRequestException(
        'map bounds are required for an entity map',
      );
    const zoom = parseMapZoom(firstQueryValue(query.zoom));
    const limit = 500;
    const tolerance = mapSimplificationToleranceMeters(zoom);
    const envelope = 'ST_MakeEnvelope($1,$2,$3,$4,4326)';
    const clipped = `ST_Transform(ST_Intersection(geom,${envelope}),3857)`;
    const simplifiedGeometry = `ST_AsGeoJSON(ST_Transform(
      CASE WHEN GeometryType(${clipped}) IN ('POLYGON','MULTIPOLYGON','LINESTRING','MULTILINESTRING')
           THEN ST_SimplifyPreserveTopology(${clipped},$5)
           ELSE ${clipped} END,4326))::jsonb`;
    const projection = entityProjectionWithGeometry(simplifiedGeometry);
    const [minLon, minLat, maxLon, maxLat] = bounds;
    const centerLon = (minLon + maxLon) / 2;
    const centerLat = (minLat + maxLat) / 2;
    const values = [...bounds, tolerance, centerLon, centerLat, limit + 1];
    const envelopeFilter = `geom && ${envelope} AND ST_Intersects(geom,${envelope})`;
    const client = await this.connect();
    try {
      const counted = await client.query(
        `SELECT count(*) AS total FROM geodata_entity WHERE ${envelopeFilter}`,
        bounds,
      );
      const rows = await client.query(
        `SELECT ${projection} AS entity FROM geodata_entity
         WHERE ${envelopeFilter}
         ORDER BY ST_Distance(ST_PointOnSurface(geom),ST_SetSRID(ST_MakePoint($6,$7),4326)),lower(name),id
         LIMIT $8`,
        values,
      );
      const total = parsePageTotal(counted.rows[0]?.total ?? '0');
      return {
        items: rows.rows.slice(0, limit).map((row) => row.entity),
        total,
        limit,
        truncated: total > limit,
        zoom,
        bbox: bounds,
      };
    } finally {
      client.release();
    }
  }

  async simplifyMapGeometries(input: unknown) {
    if (!isRecord(input) || !Array.isArray(input.items))
      throw new BadRequestException('map simplification items are required');
    const zoom = parseMapZoom(input.zoom);
    if (input.items.length > 500)
      throw new BadRequestException(
        'at most 500 map geometries may be simplified',
      );
    const items = input.items.map((item, index) => {
      if (
        !isRecord(item) ||
        typeof item.id !== 'string' ||
        item.id.length < 1 ||
        item.id.length > 200 ||
        !isRecord(item.geometry) ||
        typeof item.geometry.type !== 'string' ||
        (!('coordinates' in item.geometry) && !('geometries' in item.geometry))
      )
        throw new BadRequestException(`map geometry ${index + 1} is invalid`);
      return { id: item.id, geometry: item.geometry };
    });
    const serializedItems = stringifyJsonWithBigInts(items);
    if (Buffer.byteLength(serializedItems, 'utf8') > 4 * 1024 * 1024)
      throw new BadRequestException('map simplification payload exceeds 4 MiB');
    if (!items.length) return { items: [], zoom };

    const tolerance = mapSimplificationToleranceMeters(zoom);
    const client = await this.connect();
    try {
      const result = await client.query(
        `WITH input AS (
           SELECT item->>'id' AS id,
                  ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON((item->'geometry')::text),4326),3857) AS geom,
                  ordinal
           FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS payload(item,ordinal)
         ), candidates AS (
           SELECT id,ordinal,geom,
                  CASE WHEN GeometryType(geom) IN ('POLYGON','MULTIPOLYGON','LINESTRING','MULTILINESTRING')
                       THEN ST_SimplifyPreserveTopology(geom,$2)
                       ELSE geom END AS simplified
           FROM input
         )
         SELECT jsonb_agg(jsonb_build_object(
           'id',id,
           'geometry',ST_AsGeoJSON(ST_Transform(
             CASE WHEN ST_IsEmpty(simplified) THEN geom ELSE simplified END,4326))::jsonb
         ) ORDER BY ordinal) AS items
         FROM candidates`,
        [serializedItems, tolerance],
      );
      return { items: result.rows[0]?.items ?? [], zoom };
    } finally {
      client.release();
    }
  }

  async getEntity(id: string) {
    if (!isCanonicalUuid(id))
      throw new NotFoundException(pythonKeyErrorDetail(id));
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT ${entityProjection} AS entity FROM geodata_entity WHERE id=$1`,
        [id],
      );
      if (!result.rows[0])
        throw new NotFoundException(pythonKeyErrorDetail(id));
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
    const page = parsePageInteger(query.page, 1);
    const pageSize = parsePageInteger(query.pageSize, 50, 100);
    const client = await this.connect();
    try {
      const counted = await client.query(
        'SELECT count(*) AS total FROM import_run',
      );
      const rows = await client.query(
        `SELECT (${importProjection})::text AS run FROM import_run ORDER BY started_at DESC,id LIMIT $1 OFFSET $2`,
        [pageSize, pageOffset(page, pageSize)],
      );
      const total = parsePageTotal(counted.rows[0]?.total ?? '0');
      return {
        items: rows.rows.map(
          (row) =>
            parseJsonWithExactIntegers(row.run) as Record<string, unknown>,
        ),
        page,
        pageSize,
        total,
        nextPage: nextPageIfMore(page, pageSize, total),
      };
    } finally {
      client.release();
    }
  }

  async getImport(id: string) {
    if (!isCanonicalUuid(id))
      throw new NotFoundException(pythonKeyErrorDetail(id));
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT (${importProjection})::text AS run FROM import_run WHERE id=$1`,
        [id],
      );
      if (!result.rows[0])
        throw new NotFoundException(pythonKeyErrorDetail(id));
      return parseJsonWithExactIntegers(result.rows[0].run) as Record<
        string,
        unknown
      >;
    } finally {
      client.release();
    }
  }

  async listConflation(query: Record<string, unknown>) {
    const page = parsePageInteger(query.page, 1);
    const pageSize = parsePageInteger(query.pageSize, 50, 100);
    const resolution = firstQueryValue(query.resolution) || null;
    const client = await this.connect();
    try {
      const count = await client.query(
        'SELECT count(*) AS total FROM conflation_candidate WHERE ($1::text IS NULL OR resolution=$1)',
        [resolution],
      );
      const rows = await client.query(
        `SELECT jsonb_build_object(
          'id',replace(c.id::text,'-',''),'leftEntityId',c.left_entity_id::text,
          'rightEntityId',c.right_entity_id::text,'score',c.similarity,
          'programmeSlug',c.programme_slug,
          'signals',c.reason,'resolution',c.resolution,
          'resolutionHistory',c.resolution_history,
          'createdAt',to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'updatedAt',to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'survivorEntityId',c.survivor_entity_id::text,
          'reviewerId',COALESCE(
            (c.resolution_history->-1)->'reviewerId',
            to_jsonb(c.resolved_by::text)
          ),'resolvedAt',c.resolved_at,
          'leftEntity',jsonb_build_object('id',l.id::text,'name',l.name,
             'status',l.lifecycle_status,'geometry',ST_AsGeoJSON(l.geom)::jsonb),
          'rightEntity',jsonb_build_object('id',r.id::text,'name',r.name,
             'status',r.lifecycle_status,'geometry',ST_AsGeoJSON(r.geom)::jsonb)
        ) AS candidate
         FROM conflation_candidate c
         JOIN geodata_entity l ON l.id=c.left_entity_id
         JOIN geodata_entity r ON r.id=c.right_entity_id
         WHERE ($1::text IS NULL OR c.resolution=$1)
         ORDER BY c.id
         LIMIT $2 OFFSET $3`,
        [resolution, pageSize, pageOffset(page, pageSize)],
      );
      const total = parsePageTotal(count.rows[0]?.total ?? '0');
      return {
        items: rows.rows.map((row) => row.candidate),
        page,
        pageSize,
        total,
        nextPage: nextPageIfMore(page, pageSize, total),
      };
    } finally {
      client.release();
    }
  }

  async listImportCandidates(runId: string, query: Record<string, unknown>) {
    const page = parsePageInteger(query.page, 1);
    const pageSize = parsePageInteger(query.pageSize, 50, 100);
    const client = await this.connect();
    try {
      const counted = await client.query(
        "SELECT count(*) AS total FROM geodata_import_candidate WHERE import_run_id=$1 AND validation_status='PENDING'",
        [runId],
      );
      const result = await client.query(
        `SELECT ${candidateProjection} AS candidate
         FROM geodata_import_candidate WHERE import_run_id=$1 AND validation_status='PENDING'
         ORDER BY ordinal,id LIMIT $2 OFFSET $3`,
        [runId, pageSize, pageOffset(page, pageSize)],
      );
      const total = parsePageTotal(counted.rows[0]?.total ?? '0');
      return {
        items: result.rows.map((row) => row.candidate),
        page,
        pageSize,
        total,
        nextPage: nextPageIfMore(page, pageSize, total),
      };
    } finally {
      client.release();
    }
  }

  async getImportProcessingQueue(runId: string, queueId: string) {
    if (!isCanonicalUuid(runId) || !isCanonicalUuid(queueId))
      throw new NotFoundException(
        pythonKeyErrorDetail('import processing queue not found'),
      );
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT id,import_run_id,candidate_ids,target_status,requested_by,status,
          requested_at,started_at,completed_at,attempt_count,error,result,job_metadata
         FROM geodata_import_processing_queue WHERE id=$1 AND import_run_id=$2`,
        [queueId, runId],
      );
      const row = result.rows[0];
      if (!row)
        throw new NotFoundException(
          pythonKeyErrorDetail('import processing queue not found'),
        );
      return {
        id: row.id,
        importRunId: row.import_run_id,
        candidateIds: row.candidate_ids,
        targetStatus: row.target_status,
        requestedBy: row.requested_by,
        status: row.status,
        requestedAt: row.requested_at,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        attemptCount: Number(row.attempt_count),
        error: row.error,
        redriveHistory: Array.isArray(row.job_metadata?.redriveHistory)
          ? row.job_metadata.redriveHistory
          : [],
        result: row.result,
      };
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

  async getProgrammeMapExtent(programme: string) {
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT count(*) AS total,
          ST_XMin(ST_Extent(geom)::box2d) AS min_lon,
          ST_YMin(ST_Extent(geom)::box2d) AS min_lat,
          ST_XMax(ST_Extent(geom)::box2d) AS max_lon,
          ST_YMax(ST_Extent(geom)::box2d) AS max_lat
         FROM geodata_entity
         WHERE programme_slug=$1 AND lifecycle_status=ANY($2::text[])`,
        [programme, ['APPROVED', 'CANDIDATE']],
      );
      const row = result.rows[0];
      const total = parsePageTotal(row?.total ?? '0');
      const coordinates = [
        row?.min_lon,
        row?.min_lat,
        row?.max_lon,
        row?.max_lat,
      ];
      return {
        programme,
        total,
        bbox:
          total && coordinates.every((value) => value != null)
            ? coordinates.map(Number)
            : null,
      };
    } finally {
      client.release();
    }
  }

  async getTile(
    zoom: number,
    x: number,
    y: number,
    programme?: string,
    statuses: string[] = ['APPROVED', 'CANDIDATE'],
    limit = 500,
  ) {
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
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new BadRequestException(
        'tile feature limit must be between 1 and 500',
      );
    const count = 2 ** zoom;
    const minLon = (x / count) * 360 - 180;
    const maxLon = ((x + 1) / count) * 360 - 180;
    const latitude = (tileRow: number) =>
      (Math.atan(Math.sinh(Math.PI * (1 - (2 * tileRow) / count))) * 180) /
      Math.PI;
    const bounds = [minLon, latitude(y + 1), maxLon, latitude(y)];
    const centerLon = (minLon + maxLon) / 2;
    const centerLat = (bounds[1] + bounds[3]) / 2;
    const simplifyTolerance = mapSimplificationToleranceMeters(zoom);
    const client = await this.connect();
    try {
      const queryStarted = performance.now();
      let result;
      const filters = [
        'geom && ST_MakeEnvelope($1,$2,$3,$4,4326)',
        'ST_Intersects(geom,ST_MakeEnvelope($1,$2,$3,$4,4326))',
      ];
      const values: unknown[] = bounds;
      if (programme) {
        values.push(programme);
        filters.push(`programme_slug=$${values.length}`);
      }
      if (statuses.length) {
        values.push(statuses);
        filters.push(`lifecycle_status=ANY($${values.length}::text[])`);
      }
      values.push(centerLon, centerLat);
      values.push(simplifyTolerance);
      values.push(limit + 1);
      try {
        result = await client.query(
          `SELECT id::text,programme_slug,entity_identifier,entity_type_code,name,
            lifecycle_status AS status,ST_AsGeoJSON(ST_Transform(ST_SimplifyPreserveTopology(ST_Transform(ST_Intersection(geom,ST_MakeEnvelope($1,$2,$3,$4,4326)),3857),$${values.length - 1}),4326))::jsonb AS geometry,
            ST_X(ST_PointOnSurface(geom)) AS centroid_lon,
            ST_Y(ST_PointOnSurface(geom)) AS centroid_lat,
            country,region,province,county,city,municipality,
            public_properties,website,description
           FROM geodata_entity
           WHERE ${filters.join(' AND ')}
           ORDER BY ST_Distance(ST_PointOnSurface(geom),ST_SetSRID(ST_MakePoint($${values.length - 3},$${values.length - 2}),4326)),name,id
           LIMIT $${values.length}`,
          values,
        );
      } finally {
        this.queryMetrics.observePostgisQuery(
          (performance.now() - queryStarted) / 1000,
        );
      }
      const truncated = result.rows.length > limit;
      const features = result.rows.slice(0, limit).map((row) => {
        const properties = isRecord(row.public_properties)
          ? row.public_properties
          : {};
        return {
          type: 'Feature',
          id: row.id,
          geometry: row.geometry,
          properties: {
            name: row.name,
            entityIdentifier: row.entity_identifier,
            website: row.website,
            description: row.description,
            programmeSlug: row.programme_slug,
            status: row.status,
            entityType: row.entity_type_code,
            centroid: {
              lon: Number(row.centroid_lon),
              lat: Number(row.centroid_lat),
            },
            location: {
              country: row.country,
              region: row.region,
              province: row.province,
              county: row.county,
              city: row.city,
              municipality: row.municipality,
            },
            entityTypes: pythonTruthy(properties.entityTypes)
              ? properties.entityTypes
              : row.entity_type_code,
            sourceRef: properties.sourceRef ?? null,
            continentCode: properties.continentCode ?? null,
            countryCode: properties.countryCode ?? null,
            regionCode: properties.regionCode ?? null,
            city: properties.city ?? null,
          },
        };
      });
      const cacheInput = {
        bbox: bounds,
        zoom,
        programme: programme ?? null,
        status: statuses,
        limit,
        minute: Math.floor(Date.now() / 60_000),
      };
      const cacheKey = createHash('sha256')
        .update(
          canonicalPythonGeneratedJson(
            cacheInput,
            (path) => path[0] === 'bbox',
          ),
        )
        .digest('hex');
      return {
        type: 'FeatureCollection',
        bbox: bounds,
        features,
        count: features.length,
        truncated,
        cacheTtlSeconds: 60,
        cacheKey,
        performanceBudgetMs: 250,
        tile: { z: zoom, x, y },
        format: 'geojson-vector',
      };
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

function isCanonicalUuid(value: string) {
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
}

function entityProjectionWithGeometry(geometryExpression: string) {
  return `public_properties || jsonb_build_object(
  'id',id::text,'programmeSlug',programme_slug,'entityIdentifier',entity_identifier,'entityType',entity_type_code,
  'name',name,'website',website,'description',description,'status',lifecycle_status,
  'geometry',${geometryExpression},
  'centroid',jsonb_build_object('lon',ST_X(COALESCE(centroid,ST_Centroid(geom)::geography)::geometry),'lat',ST_Y(COALESCE(centroid,ST_Centroid(geom)::geography)::geometry)),
  'maidenheadGridSquares4',maidenhead_grid_squares_4,'maidenheadLocators6',maidenhead_locators_6,
  'sourceState',source_state,'jurisdiction',jurisdiction,'attachments',attachments,'version',revision,
  'manualLocationFields',manual_location_fields,
  'continent',continent,'continentCode',continent_code,'country',country,
  'countryCode',country_code,'region',region,'regionCode',region_code,
  'subdivision',subdivision,'subdivisionCode',subdivision_code,
  'province',province,'provinceCode',province_code,'county',county,
  'countyCode',county_code,'city',city,'municipality',municipality,
  'locality',locality,
  'categories',COALESCE((SELECT jsonb_agg(category_code ORDER BY ordinal) FROM geodata_entity_category c WHERE c.entity_id=geodata_entity.id),'[]'::jsonb),
  'location',jsonb_build_object('continent',continent,'continentCode',continent_code,
    'country',country,'countryCode',country_code,'region',region,'regionCode',region_code,
    'subdivision',subdivision,'subdivisionCode',subdivision_code,'province',province,
    'provinceCode',province_code,'county',county,'countyCode',county_code,'city',city,
    'municipality',municipality,'locality',locality)
)`;
}

export const entityProjection = entityProjectionWithGeometry(
  'ST_AsGeoJSON(geom)::jsonb',
);

export const importProjection = `(source_metadata - 'sourceFeatureHashOverrides') || jsonb_build_object(
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
  'programmeSlug',programme_slug,
  'existingEntityId',existing_entity_id,'name',name,'entityTypes',entity_type_codes,
  'entityIdentifier',(SELECT entity_identifier FROM geodata_entity WHERE id=existing_entity_id),
  'geometry',ST_AsGeoJSON(geom)::jsonb,
  'centroid',jsonb_build_object('lon',ST_X(ST_Centroid(geom)),'lat',ST_Y(ST_Centroid(geom))),
  'sourceRef',source_ref,'candidateSource',candidate_source,
  'dedupeWarning',CASE WHEN jsonb_array_length(COALESCE(entity_payload->'possibleDuplicates','[]'::jsonb))>0 THEN 'POSSIBLE_DUPLICATE' ELSE NULL END,
  'possibleDuplicates',COALESCE(entity_payload->'possibleDuplicates','[]'::jsonb),
  'validationStatus',validation_status,'validationNote',validation_note,
  'validatedBy',validated_by,'validatedAt',validated_at,'targetStatus',target_status,
  'processedEntityId',processed_entity_id,'processedAt',processed_at,
  'location',jsonb_build_object(
    'continent',COALESCE(entity_payload->'continent',entity_payload->'location'->'continent'),
    'country',COALESCE(entity_payload->'country',entity_payload->'location'->'country'),
    'region',COALESCE(entity_payload->'region',entity_payload->'location'->'region'),
    'province',COALESCE(entity_payload->'province',entity_payload->'location'->'province'),
    'county',COALESCE(entity_payload->'county',entity_payload->'location'->'county'),
    'city',COALESCE(entity_payload->'city',entity_payload->'location'->'city'),
    'municipality',COALESCE(entity_payload->'municipality',entity_payload->'location'->'municipality'),
    'locality',COALESCE(entity_payload->'locality',entity_payload->'location'->'locality')))`;

function listValues(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : typeof value === 'string'
      ? [value]
      : [];
}

function parseBounds(query: Record<string, unknown>) {
  const names = ['minLon', 'minLat', 'maxLon', 'maxLat'] as const;
  const legacyValues = names.map((name) => firstQueryValue(query[name]));
  const hasLegacyBounds = legacyValues.some(
    (value) => value !== undefined && value !== '',
  );
  const bbox = firstQueryValue(query.bbox) ?? '';
  let raw: number[];
  if (bbox && !hasLegacyBounds) {
    const values = bbox.split(',').map((value) => trimPythonWhitespace(value));
    if (values.length !== 4)
      throw new BadRequestException(
        'bbox must contain minLon,minLat,maxLon,maxLat',
      );
    raw = parseBoundsValues(values, 'bbox must contain numeric coordinates');
  } else if (hasLegacyBounds) {
    const values = legacyValues.map((value) =>
      value === undefined ? '' : trimPythonWhitespace(value),
    );
    raw = parseBoundsValues(
      values,
      'minLon, minLat, maxLon and maxLat must be numbers',
    );
  } else {
    return null;
  }
  if (
    !raw.every(Number.isFinite) ||
    raw[0]! < -180 ||
    raw[0]! >= raw[2]! ||
    raw[2]! > 180 ||
    raw[1]! < -90 ||
    raw[1]! >= raw[3]! ||
    raw[3]! > 90
  )
    throw new BadRequestException(
      'map bounds must be a valid WGS 84 bounding box',
    );
  return raw;
}

function parseMapZoom(value: unknown): number {
  const zoom =
    typeof value === 'number' ? value : Number(firstQueryValue(value));
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > 22)
    throw new BadRequestException('map zoom must be an integer from 0 to 22');
  return zoom;
}

function parseBoundsValues(values: string[], message: string): number[] {
  try {
    return values.map(parsePythonFloatText);
  } catch {
    throw new BadRequestException(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
