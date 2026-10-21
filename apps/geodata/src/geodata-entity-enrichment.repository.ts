import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { AccessTokenClaims } from '@app/platform/access-token.js';
import { pythonKeyErrorDetail } from '@app/platform/python-strings.js';
import { utcTimestamp } from '@app/platform/utc-timestamp.js';
import { pythonTruthy } from '@app/platform/python-truthiness.js';
import { missingLocationFields } from './geodata-location-enrichment.js';
import {
  lockRequest,
  readRequestResponse,
  replayRequest,
  requestResponse,
} from './geodata-request-idempotency.js';
import {
  assertGisAdminCoverage,
  isRecord,
  parseIfMatch,
} from './geodata-entity-mutation.helpers.js';
import { GeodataEntityMutationSupport } from './geodata-entity-mutation-support.js';

@Injectable()
export class GeodataEntityEnrichmentRequestRepository {
  constructor(private readonly support: GeodataEntityMutationSupport) {}

  async requestLocationEnrichment(
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
        'geodata-location-enrichment',
        key,
        requestHash,
      );
      if (replay.found) return replay.response;
    }
    const editorId = body.editorId;
    const expectedVersion = parseIfMatch(ifMatch);
    const client = await this.support.connect();
    try {
      await client.query('BEGIN');
      if (key) await lockRequest(client, key);
      const selected = await client.query(
        `SELECT id,revision,geom,programme_slug,jurisdiction,entity_type_code,
          ST_AsGeoJSON(geom)::jsonb AS geometry,
          continent,continent_code,country,country_code,region,region_code,subdivision,subdivision_code,
          city,municipality,manual_location_fields,public_properties
         FROM geodata_entity WHERE id=$1 FOR UPDATE`,
        [id],
      );
      const row = selected.rows[0];
      if (!row) throw new NotFoundException(pythonKeyErrorDetail(id));
      assertGisAdminCoverage(claims, row, 'geodata.location.manage');
      if (!pythonTruthy(editorId))
        throw new BadRequestException('editorId is required');
      if (key) {
        const previous = await readRequestResponse(
          client,
          'geodata-location-enrichment',
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
      if (!row.geometry)
        throw new ConflictException(
          'location enrichment requires entity geometry',
        );
      const properties = isRecord(row.public_properties)
        ? row.public_properties
        : {};
      const manual = Array.isArray(row.manual_location_fields)
        ? row.manual_location_fields.filter(
            (field: unknown): field is string => typeof field === 'string',
          )
        : [];
      const location = {
        continent: row.continent,
        continentCode: row.continent_code,
        country: row.country,
        countryCode: row.country_code,
        region: row.region,
        regionCode: row.region_code,
        subdivision: row.subdivision,
        subdivisionCode: row.subdivision_code,
        city: row.city,
        municipality: row.municipality,
      };
      const missing = missingLocationFields(location, manual);
      if (!missing.length)
        throw new ConflictException('location metadata is already complete');
      const geometryHash = createHash('sha256')
        .update(stringifyJsonWithBigInts(row.geometry))
        .digest('hex');
      if (
        properties.locationEnrichmentStatus === 'QUEUED' &&
        properties.locationEnrichmentGeometryHash === geometryHash
      ) {
        const receipt = {
          entityId: id,
          requestId: properties.locationEnrichmentRequestId,
          status: 'QUEUED',
          missingFields: missing,
          queued: true,
        };
        if (key)
          await client.query(
            'INSERT INTO idempotency_record(service,key,response) VALUES ($1,$2,$3::jsonb)',
            [
              'geodata-location-enrichment',
              key,
              stringifyJsonWithBigInts(requestResponse(receipt, requestHash)),
            ],
          );
        await client.query('COMMIT');
        return receipt;
      }
      const requestId = randomUUID();
      const requestedAt = await utcTimestamp(client);
      const nextProperties = {
        ...properties,
        locationEnrichmentRequestId: requestId,
        locationEnrichmentGeometryHash: geometryHash,
        locationEnrichmentStatus: 'QUEUED',
        locationEnrichmentOnlyMissing: true,
        locationEnrichmentReason: 'ADMIN_REQUESTED_MISSING_METADATA',
        locationEnrichmentRequestedAt: requestedAt,
        locationEnrichmentRequestedBy: editorId,
      };
      delete nextProperties.locationEnrichmentError;
      await client.query(
        `UPDATE geodata_entity SET public_properties=$2::jsonb,
          location_work_dispatched_at=now(),updated_at=$3 WHERE id=$1`,
        [id, stringifyJsonWithBigInts(nextProperties), requestedAt],
      );
      const event = {
        entityId: id,
        requestId,
        geometryHash,
        onlyMissing: true,
        reason: 'ADMIN_REQUESTED_MISSING_METADATA',
        requestedBy: editorId,
        natsSubject: 'myota.geodata.entity.location-enrichment.v1',
      };
      await this.support.writeEntityEvent(
        client,
        id,
        'geodata.entity.location-enrichment-requested.v1',
        event,
        requestedAt,
      );
      const receipt = {
        entityId: id,
        requestId,
        status: 'QUEUED',
        missingFields: missing,
        queued: true,
      };
      if (key)
        await client.query(
          'INSERT INTO idempotency_record(service,key,response) VALUES ($1,$2,$3::jsonb)',
          [
            'geodata-location-enrichment',
            key,
            stringifyJsonWithBigInts(requestResponse(receipt, requestHash)),
          ],
        );
      await client.query('COMMIT');
      return receipt;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
