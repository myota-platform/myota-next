import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AccessTokenClaims } from '@app/platform/access-token.js';
import { pythonKeyErrorDetail } from '@app/platform/python-strings.js';
import { utcTimestamp } from '@app/platform/utc-timestamp.js';
import { pythonTruthy } from '@app/platform/python-truthiness.js';
import { validateGeometryCoordinates } from '@app/geodata-domain';
import {
  locationSnapshot,
  queueLocationEnrichment,
} from './geodata-location-enrichment.js';
import {
  lockRequest,
  readRequestResponse,
  replayRequest,
  requestResponse,
} from './geodata-request-idempotency.js';
import {
  assertReviewCoverage,
  isRecord,
  MAX_COORDINATES,
  parseIfMatch,
} from './geodata-entity-mutation.helpers.js';
import { GeodataEntityMutationSupport } from './geodata-entity-mutation-support.js';

@Injectable()
export class GeodataEntityGeometryRepository {
  constructor(private readonly support: GeodataEntityMutationSupport) {}

  async replaceEntityGeometry(
    id: string,
    key: string | undefined,
    ifMatch: string | undefined,
    body: Record<string, unknown>,
    claims: AccessTokenClaims,
    requestHash?: string,
  ) {
    if (key && requestHash) {
      const replay = await replayRequest(
        () => this.support.connect(),
        'geodata-entity-geometry',
        key,
        requestHash,
      );
      if (replay.found) return replay.response;
    }
    const editorId = body.editorId;
    const note = body.note === undefined ? null : body.note;
    const client = await this.support.connect();
    try {
      await client.query('BEGIN');
      if (key) await lockRequest(client, key);
      const selected = await client.query(
        `SELECT id,revision,programme_slug,jurisdiction,entity_type_code,
          ST_AsGeoJSON(geom)::jsonb AS geometry,public_properties,
          continent,continent_code,country,country_code,region,region_code,
          subdivision,subdivision_code,province,province_code,county,county_code,
          city,municipality,locality,manual_location_fields
         FROM geodata_entity WHERE id=$1 FOR UPDATE`,
        [id],
      );
      const row = selected.rows[0];
      if (!row) throw new NotFoundException(pythonKeyErrorDetail(id));
      assertReviewCoverage(claims, row);
      const missing = [
        ...(!pythonTruthy(body.geometry) ? ['geometry'] : []),
        ...(!pythonTruthy(editorId) ? ['editorId'] : []),
      ];
      if (missing.length)
        throw new BadRequestException(
          `missing required fields: ${missing.join(', ')}`,
        );
      const geometryInput = isRecord(body.geometry) ? body.geometry : null;
      const rawGeometryType =
        typeof geometryInput?.type === 'string' ? geometryInput.type : '';
      const geometryTypeAliases: Record<string, string> = {
        way: 'LineString',
        linestring: 'LineString',
        multilinestring: 'MultiLineString',
      };
      const geometryType =
        geometryTypeAliases[rawGeometryType.toLowerCase()] ?? rawGeometryType;
      if (
        ![
          'Point',
          'LineString',
          'MultiLineString',
          'Polygon',
          'MultiPolygon',
        ].includes(geometryType) ||
        !geometryInput ||
        !('coordinates' in geometryInput)
      )
        throw new BadRequestException(
          'geometry must be a supported GeoJSON geometry',
        );
      try {
        validateGeometryCoordinates(
          geometryType,
          geometryInput.coordinates,
          MAX_COORDINATES,
        );
      } catch (error) {
        throw new BadRequestException(
          error instanceof Error
            ? error.message
            : 'invalid geometry coordinates',
        );
      }
      const geometry = stringifyJsonWithBigInts({
        type: geometryType,
        coordinates: geometryInput.coordinates,
      });
      if (Buffer.byteLength(geometry) > 5 * 1024 * 1024)
        throw new BadRequestException('geometry exceeds the 5 MiB limit');
      const expectedVersion = parseIfMatch(ifMatch);
      if (key) {
        const previous = await readRequestResponse(
          client,
          'geodata-entity-geometry',
          key,
          requestHash,
        );
        if (previous.found) {
          await client.query('COMMIT');
          return previous.response;
        }
      }
      if (expectedVersion !== null && Number(row.revision) !== expectedVersion)
        throw new ConflictException('entity version is stale');
      const checked = await client.query(
        `SELECT ST_IsEmpty(g) AS empty,
          ST_AsGeoJSON(g)::jsonb AS canonical_geometry,
          ST_XMin(Box3D(g)) AS min_x,ST_XMax(Box3D(g)) AS max_x,
          ST_YMin(Box3D(g)) AS min_y,ST_YMax(Box3D(g)) AS max_y
         FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1),4326) AS g) input`,
        [geometry],
      );
      const bounds = checked.rows[0];
      const canonicalGeometry = bounds?.canonical_geometry as
        Record<string, unknown> | undefined;
      if (
        !bounds ||
        bounds.empty ||
        Number(bounds.min_x) < -180 ||
        Number(bounds.max_x) > 180 ||
        Number(bounds.min_y) < -90 ||
        Number(bounds.max_y) > 90
      )
        throw new BadRequestException('geometry must be within WGS84 bounds');
      const geometryChanged = Boolean(
        canonicalGeometry &&
        stringifyJsonWithBigInts(row.geometry) !==
          stringifyJsonWithBigInts(canonicalGeometry),
      );
      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      const properties = isRecord(row.public_properties)
        ? row.public_properties
        : {};
      const changedAt = await utcTimestamp(client);
      const geometryHistory = Array.isArray(properties.geometryHistory)
        ? [...properties.geometryHistory]
        : [];
      geometryHistory.push({
        editorId,
        note,
        geometry: row.geometry,
        editedAt: changedAt,
      });
      let nextProperties: Record<string, unknown> = {
        ...properties,
        geometryHistory,
        updatedAt: changedAt,
      };
      const enrichment = geometryChanged
        ? queueLocationEnrichment(
            id,
            nextProperties,
            canonicalGeometry,
            locationSnapshot(row),
            row.manual_location_fields,
            'GEOMETRY_CHANGED',
            editorId,
            false,
            await utcTimestamp(client),
          )
        : undefined;
      if (enrichment) nextProperties = enrichment.properties;
      await client.query(
        `UPDATE geodata_entity SET geom=ST_SetSRID(ST_GeomFromGeoJSON($2),4326),
         centroid=ST_Centroid(ST_SetSRID(ST_GeomFromGeoJSON($2),4326))::geography,
         public_properties=$3::jsonb,
         location_work_dispatched_at=CASE WHEN $5 THEN now() ELSE location_work_dispatched_at END,
         updated_at=$4 WHERE id=$1`,
        [
          id,
          geometry,
          stringifyJsonWithBigInts(nextProperties),
          changedAt,
          geometryChanged,
        ],
      );
      await this.support.writeEntityEvent(
        client,
        id,
        'geodata.entity.geometry-updated.v1',
        { entityId: id, editorId, note, geometry: body.geometry },
        changedAt,
      );
      if (enrichment)
        await this.support.writeEntityEvent(
          client,
          id,
          'geodata.entity.location-enrichment-requested.v1',
          enrichment.event,
          enrichment.requestedAt,
        );
      const response = await this.support.readEntityWithClient(client, id);
      if (key)
        await client.query(
          'INSERT INTO idempotency_record(service,key,response) VALUES ($1,$2,$3::jsonb)',
          [
            'geodata-entity-geometry',
            key,
            stringifyJsonWithBigInts(requestResponse(response, requestHash)),
          ],
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
}
