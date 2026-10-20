import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import { unicodeCaseFold } from '@app/platform/unicode-casefold.js';
import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';

type EnrichmentJob = {
  id: string;
  requestId: string;
  geometryHash: string;
  onlyMissing: boolean;
  reason: string;
  requestedBy: unknown;
  geometry: Record<string, unknown>;
  point: [number, number] | null;
};
type GeocodeResult = {
  provider: string;
  status: string;
  lookupSource: string | null;
  geocodedAt: string;
  payload: Record<string, unknown>;
  location: Record<string, unknown>;
  error?: string;
};

const fields: Record<string, string> = {
  continent: 'continent',
  continentCode: 'continent_code',
  country: 'country',
  countryCode: 'country_code',
  region: 'region',
  regionCode: 'region_code',
  subdivision: 'subdivision',
  subdivisionCode: 'subdivision_code',
  province: 'province',
  provinceCode: 'province_code',
  county: 'county',
  countyCode: 'county_code',
  city: 'city',
  municipality: 'municipality',
  locality: 'locality',
};
const codeParent: Record<string, string[]> = {
  continentCode: ['continent'],
  countryCode: ['country'],
  regionCode: ['region', 'subdivision'],
  subdivisionCode: ['region', 'subdivision'],
  provinceCode: ['province'],
  countyCode: ['county'],
};

@Injectable()
export class GeodataEnrichmentRepository {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async claim(
    entityId?: string,
    requestId?: string,
  ): Promise<EnrichmentJob | null> {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        `SELECT id::text,public_properties,ST_AsGeoJSON(geom)::jsonb AS geometry,
          ST_X(COALESCE(centroid,ST_Centroid(geom)::geography)::geometry) AS lon,
          ST_Y(COALESCE(centroid,ST_Centroid(geom)::geography)::geometry) AS lat
         FROM geodata_entity
         WHERE public_properties->>'locationEnrichmentStatus' IN ('QUEUED','PROCESSING')
           AND ($1::uuid IS NULL OR id=$1)
           AND ($2::uuid IS NULL OR public_properties->>'locationEnrichmentRequestId'=$2)
           AND location_work_dispatched_at <= now()
         ORDER BY location_work_dispatched_at,id
        FOR UPDATE SKIP LOCKED LIMIT 1`,
        [entityId ?? null, requestId ?? null],
      );
      const row = selected.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return null;
      }
      const props = record(row.public_properties);
      const job: EnrichmentJob = {
        id: String(row.id),
        requestId: String(props.locationEnrichmentRequestId ?? ''),
        geometryHash: String(props.locationEnrichmentGeometryHash ?? ''),
        onlyMissing: props.locationEnrichmentOnlyMissing === true,
        reason: String(props.locationEnrichmentReason ?? 'UNSPECIFIED'),
        requestedBy: props.locationEnrichmentRequestedBy,
        geometry: record(row.geometry),
        point:
          Number.isFinite(Number(row.lon)) && Number.isFinite(Number(row.lat))
            ? [Number(row.lon), Number(row.lat)]
            : null,
      };
      await client.query(
        `UPDATE geodata_entity SET public_properties=public_properties || $2::jsonb,
          location_work_dispatched_at=now()+interval '5 minutes'
         WHERE id=$1`,
        [
          job.id,
          stringifyJsonWithBigInts({ locationEnrichmentStatus: 'PROCESSING' }),
        ],
      );
      await client.query('COMMIT');
      return job;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getRequestState(entityId: string): Promise<{
    status: string | null;
    requestId: string | null;
    leaseRemainingSeconds: number;
  } | null> {
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT public_properties->>'locationEnrichmentStatus' AS status,
          public_properties->>'locationEnrichmentRequestId' AS request_id,
          GREATEST(0,EXTRACT(EPOCH FROM (location_work_dispatched_at-now()))) AS lease_remaining
         FROM geodata_entity WHERE id=$1`,
        [entityId],
      );
      const row = result.rows[0];
      return row
        ? {
            status: row.status,
            requestId: row.request_id,
            leaseRemainingSeconds: Number(row.lease_remaining ?? 0),
          }
        : null;
    } finally {
      client.release();
    }
  }

  async process(job: EnrichmentJob) {
    const preflight = await this.connect();
    try {
      await preflight.query('BEGIN');
      const selected = await preflight.query(
        `SELECT public_properties,ST_AsGeoJSON(geom)::jsonb AS geometry
           FROM geodata_entity WHERE id=$1 FOR UPDATE`,
        [job.id],
      );
      const row = selected.rows[0];
      if (!row) {
        await preflight.query('COMMIT');
        return;
      }
      const props = record(row.public_properties);
      if (props.locationEnrichmentRequestId !== job.requestId) {
        await preflight.query('COMMIT');
        return;
      }
      if (geometryHash(row.geometry) !== job.geometryHash) {
        const completedAt = new Date();
        const stale = {
          ...props,
          locationEnrichmentStatus: 'SUPERSEDED',
          locationEnrichmentCompletedAt: completedAt.toISOString(),
        };
        await preflight.query(
          'UPDATE geodata_entity SET public_properties=$2::jsonb,updated_at=$3 WHERE id=$1',
          [job.id, stringifyJsonWithBigInts(stale), completedAt],
        );
        await this.writeEvent(
          preflight,
          job.id,
          'geodata.entity.location-enriched.v1',
          {
            entityId: job.id,
            requestId: job.requestId,
            geometryHash: job.geometryHash,
            status: 'SUPERSEDED',
            reason: job.reason,
          },
          completedAt,
        );
        await preflight.query('COMMIT');
        return;
      }
      if (
        props.locationEnrichmentStatus === 'COMPLETED' ||
        props.locationEnrichmentStatus === 'FAILED'
      ) {
        await preflight.query('COMMIT');
        return;
      }
      await preflight.query('COMMIT');
    } catch (error) {
      await preflight.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      preflight.release();
    }

    const result = await reverseGeocode(job.point);
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        `SELECT public_properties,manual_location_fields,
          ST_AsGeoJSON(geom)::jsonb AS geometry,
          continent,continent_code,country,country_code,region,region_code,
          subdivision,subdivision_code,province,province_code,county,county_code,
          city,municipality,locality
         FROM geodata_entity WHERE id=$1 FOR UPDATE`,
        [job.id],
      );
      const row = selected.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return;
      }
      const props = record(row.public_properties);
      if (props.locationEnrichmentRequestId !== job.requestId) {
        await client.query('COMMIT');
        return;
      }
      if (geometryHash(row.geometry) !== job.geometryHash) {
        const completedAt = new Date();
        const stale = {
          ...props,
          locationEnrichmentStatus: 'SUPERSEDED',
          locationEnrichmentCompletedAt: completedAt.toISOString(),
        };
        await client.query(
          'UPDATE geodata_entity SET public_properties=$2::jsonb,updated_at=$3 WHERE id=$1',
          [job.id, stringifyJsonWithBigInts(stale), completedAt],
        );
        await this.writeEvent(
          client,
          job.id,
          'geodata.entity.location-enriched.v1',
          {
            entityId: job.id,
            requestId: job.requestId,
            geometryHash: job.geometryHash,
            status: 'SUPERSEDED',
            reason: job.reason,
          },
          completedAt,
        );
        await client.query('COMMIT');
        return;
      }
      const manual = Array.isArray(row.manual_location_fields)
        ? row.manual_location_fields.filter(
            (field: unknown): field is string => typeof field === 'string',
          )
        : [];
      const current: Record<string, unknown> = {};
      for (const [field, column] of Object.entries(fields))
        current[field] = row[column];
      for (const [field, value] of Object.entries(result.location)) {
        if (!(field in fields) || manual.includes(field)) continue;
        if (
          (field === 'region' && manual.includes('subdivision')) ||
          (field === 'subdivision' && manual.includes('region'))
        )
          continue;
        if ((codeParent[field] ?? []).some((parent) => manual.includes(parent)))
          continue;
        if (job.onlyMissing && current[field] !== null && current[field] !== '')
          continue;
        current[field] = value;
      }
      const completedAt = new Date();
      const enrichmentStatus =
        result.status === 'ENRICHED' ? 'COMPLETED' : 'FAILED';
      const nextProps: Record<string, unknown> = {
        ...props,
        locationEnrichmentStatus: enrichmentStatus,
        locationEnrichmentCompletedAt: completedAt.toISOString(),
        locationEnrichmentGeometryHash: job.geometryHash,
        locationEnrichmentReason: job.reason,
        geocodeProvider: result.provider,
        geocodeStatus: result.status,
        geocodeLookupSource: result.lookupSource,
        geocodedAt: result.geocodedAt,
        provenance: {
          ...record(props.provenance),
          reverseGeocoding: { ...result, response: result.payload },
        },
      };
      delete nextProps.geocodeError;
      delete nextProps.locationEnrichmentError;
      if (result.error) {
        nextProps.geocodeError = result.error;
        nextProps.locationEnrichmentError = result.error;
      }
      const params: unknown[] = [job.id];
      const assignments = Object.entries(current).map(([field, value]) => {
        params.push(value);
        return `${fields[field]}=$${params.length}`;
      });
      params.push(
        result.provider,
        result.status,
        result.lookupSource,
        result.geocodedAt,
        stringifyJsonWithBigInts(result.payload ?? {}),
        stringifyJsonWithBigInts(nextProps),
        completedAt,
      );
      const start = params.length - 6;
      assignments.push(
        `geocode_provider=$${start}`,
        `geocode_status=$${start + 1}`,
        `geocode_lookup_source=$${start + 2}`,
        `geocoded_at=$${start + 3}`,
        `geocode_payload=$${start + 4}::jsonb`,
        `public_properties=$${start + 5}::jsonb`,
        `updated_at=$${start + 6}`,
      );
      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await client.query(
        `UPDATE geodata_entity SET ${assignments.join(',')} WHERE id=$1`,
        params,
      );
      await this.writeEvent(
        client,
        job.id,
        'geodata.entity.location-enriched.v1',
        {
          entityId: job.id,
          requestId: job.requestId,
          geometryHash: job.geometryHash,
          status: enrichmentStatus,
          reason: job.reason,
        },
        completedAt,
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async writeEvent(
    client: PoolClient,
    id: string,
    type: string,
    payload: unknown,
    occurredAt: Date,
  ) {
    await client.query(
      `INSERT INTO outbox_event(event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
       VALUES ($1,$2,'geodata-worker','entity',$3,$4::jsonb,$5,$6)`,
      [
        randomUUID(),
        type,
        id,
        stringifyJsonWithBigInts(payload),
        occurredAt,
        randomUUID(),
      ],
    );
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

async function reverseGeocode(
  coordinates: [number, number] | null,
): Promise<GeocodeResult> {
  const key = process.env.BIGDATACLOUD_API_KEY?.trim();
  const geocodedAt = new Date().toISOString();
  if (!key || !coordinates)
    return {
      provider: 'BIGDATACLOUD',
      status: key ? 'FAILED' : 'NOT_CONFIGURED',
      lookupSource: null,
      geocodedAt,
      payload: {},
      location: {},
      ...(key ? { error: 'Geometry has no representative point.' } : {}),
    };
  const endpoint =
    process.env.BIGDATACLOUD_REVERSE_GEOCODE_URL ??
    'https://api-bdc.net/data/reverse-geocode';
  const url = new URL(endpoint);
  url.searchParams.set('latitude', String(roundToFiveDecimals(coordinates[1])));
  url.searchParams.set(
    'longitude',
    String(roundToFiveDecimals(coordinates[0])),
  );
  url.searchParams.set(
    'localityLanguage',
    process.env.BIGDATACLOUD_LOCALITY_LANGUAGE ?? 'en',
  );
  url.searchParams.set('key', key);
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'MyOTA-geodata-service/1.0',
      },
      signal: AbortSignal.timeout(
        boundedTimeout(process.env.BIGDATACLOUD_TIMEOUT_SECONDS),
      ),
    });
    if (!response.ok)
      throw new Error(`reverse geocoder returned HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw new Error('reverse geocoding response was not an object');
    const data = payload as Record<string, any>;
    const region = data.principalSubdivision ?? null;
    const city = data.city ?? data.locality ?? null;
    const administrative = record(data.localityInfo).administrative;
    const entries = (Array.isArray(administrative) ? administrative : [])
      .map(record)
      .sort(
        (left, right) =>
          Number(left.order ?? 999) - Number(right.order ?? 999) ||
          Number(left.adminLevel ?? 999) - Number(right.adminLevel ?? 999),
      )
      .filter(
        (entry) =>
          !(
            data.principalSubdivisionCode &&
            entry.isoCode === data.principalSubdivisionCode
          ) &&
          !(
            region &&
            unicodeCaseFold(text(entry.name)) === unicodeCaseFold(text(region))
          ),
      );
    const province = pickAdministrative(
      entries,
      ['province', 'provincia', 'state', 'department', 'prefecture', 'oblast'],
      [6],
    );
    let county = pickAdministrative(
      entries.filter((entry) => entry !== province),
      ['county', 'comarca', 'district', 'arrondissement', 'municipality'],
      [5, 7],
    );
    let countyName = firstValue(county, 'name', 'isoName');
    const provinceName = firstValue(province, 'name', 'isoName');
    if (
      countyName &&
      [provinceName, city].some(
        (value) =>
          unicodeCaseFold(text(value)) === unicodeCaseFold(text(countyName)),
      )
    ) {
      county = undefined;
      countyName = undefined;
    }
    return {
      provider: 'BIGDATACLOUD',
      status: 'ENRICHED',
      lookupSource: data.lookupSource ?? null,
      geocodedAt,
      payload: data,
      location: {
        continent: data.continent ?? null,
        continentCode: data.continentCode ?? null,
        country: data.countryName ?? null,
        countryCode: data.countryCode ?? null,
        region,
        regionCode: data.principalSubdivisionCode ?? null,
        subdivision: region,
        subdivisionCode: data.principalSubdivisionCode ?? null,
        province: provinceName ?? null,
        provinceCode: firstValue(province, 'isoCode') ?? null,
        county: countyName ?? null,
        countyCode: firstValue(county, 'isoCode') ?? null,
        city,
        municipality: city,
        locality: data.locality ?? null,
      },
    };
  } catch (error) {
    return {
      provider: 'BIGDATACLOUD',
      status: 'FAILED',
      lookupSource: null,
      geocodedAt,
      payload: {},
      location: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function geometryHash(value: unknown) {
  return createHash('sha256')
    .update(stringifyJsonWithBigInts(value))
    .digest('hex');
}
function record(value: unknown): Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}
function boundedTimeout(value: string | undefined) {
  const seconds = Number(value ?? 10);
  return Number.isFinite(seconds) && seconds >= 1 && seconds <= 60
    ? seconds * 1000
    : 10000;
}
function roundToFiveDecimals(value: number) {
  return Number(value.toFixed(5));
}
function text(value: unknown) {
  return typeof value === 'string' ? value : '';
}
function firstValue(entry: Record<string, any> | undefined, ...keys: string[]) {
  if (!entry) return undefined;
  return keys
    .map((key) => entry[key])
    .find((value) => value !== null && value !== undefined && value !== '');
}
function pickAdministrative(
  entries: Record<string, any>[],
  patterns: string[],
  levels: number[],
) {
  for (const entry of entries) {
    const searchable = [entry.name, entry.description, entry.isoName]
      .map(text)
      .join(' ')
      .toLowerCase();
    if (patterns.some((pattern) => searchable.includes(pattern))) return entry;
  }
  return entries.find((entry) => levels.includes(Number(entry.adminLevel)));
}
