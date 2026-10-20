import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { integerSetting } from '@app/platform/integer-setting.js';
import { unicodeCaseFold } from '@app/platform/unicode-casefold.js';
import type { AccessTokenClaims } from '@app/platform/access-token.js';
import {
  firstPythonTruthy,
  pythonTruthy,
} from '@app/platform/python-truthiness.js';
import { trimPythonWhitespace } from '@app/platform/python-strings.js';
import { validateGeometryCoordinates } from '@app/geodata-domain';
import { entityProjection } from './geodata.repository.js';
import {
  locationSnapshot,
  missingLocationFields,
  queueLocationEnrichment,
} from './geodata-location-enrichment.js';
import {
  lockRequest,
  readRequestResponse,
  replayRequest,
  requestResponse,
} from './geodata-request-idempotency.js';

const MAX_COORDINATES = integerSetting(
  process.env.GEODATA_MAX_COORDINATES,
  50_000,
);

const locationColumns: Record<string, string> = {
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
const providerDerivedLocationFields = new Set([
  'continentCode',
  'countryCode',
  'regionCode',
  'subdivisionCode',
  'provinceCode',
]);
const manualLocationFields = new Set(
  Object.keys(locationColumns).filter(
    (field) => !providerDerivedLocationFields.has(field),
  ),
);

@Injectable()
export class GeodataEntityMutationRepository {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async reviewEntity(
    id: string,
    key: string | undefined,
    ifMatch: string | undefined,
    body: Record<string, unknown>,
    claims: AccessTokenClaims,
    requestHash?: string,
  ) {
    if (key && requestHash) {
      const replay = await replayRequest(
        () => this.connect(),
        'geodata-entity-review',
        key,
        requestHash,
      );
      if (replay.found) return replay.response;
    }
    const reviewerId = body.reviewerId;
    const requestedStatus = firstPythonTruthy(body.status, body.decision);
    const targetStatus =
      typeof requestedStatus === 'string' ? requestedStatus : '';
    const note = body.note === undefined ? null : body.note;
    if (!pythonTruthy(reviewerId))
      throw new BadRequestException('reviewerId is required');
    if (
      !['APPROVED', 'CANDIDATE', 'RETIRED', 'REJECTED'].includes(targetStatus)
    )
      throw new BadRequestException('unsupported entity review status');
    const expectedVersion = parseIfMatch(ifMatch);
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      if (key) await lockRequest(client, key);
      const result = await client.query(
        `SELECT id,revision,lifecycle_status,programme_slug,jurisdiction,
          entity_type_code,public_properties,
          ST_AsGeoJSON(geom)::jsonb AS geometry,continent,continent_code,
          country,country_code,region,region_code,subdivision,subdivision_code,
          province,province_code,county,county_code,city,municipality,locality,
          manual_location_fields
         FROM geodata_entity WHERE id=$1 FOR UPDATE`,
        [id],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundException('geodata entity not found');
      assertReviewCoverage(claims, row);
      if (key) {
        const previous = await readRequestResponse(
          client,
          'geodata-entity-review',
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
      const previousStatus = String(row.lifecycle_status);
      if (
        (previousStatus === 'APPROVED' && targetStatus !== 'RETIRED') ||
        (previousStatus === 'RETIRED' && targetStatus !== 'RETIRED') ||
        (previousStatus === 'CANDIDATE' &&
          !['CANDIDATE', 'APPROVED', 'REJECTED'].includes(targetStatus)) ||
        (previousStatus === 'REJECTED' && targetStatus !== 'REJECTED')
      )
        throw new ConflictException(
          'entity cannot transition to the requested status',
        );
      if (targetStatus !== previousStatus) {
        await client.query(
          "SELECT set_config('myota.geodata_writer','row-v1',true)",
        );
        const properties = isRecord(row.public_properties)
          ? row.public_properties
          : {};
        const changedAt = new Date();
        const review = {
          ...(isRecord(properties.review) ? properties.review : {}),
          reviewerId,
          note,
          changedAt: changedAt.toISOString(),
        };
        const reviewHistory = Array.isArray(properties.reviewHistory)
          ? [...properties.reviewHistory]
          : [];
        reviewHistory.push({
          action: 'STATUS_CHANGED',
          status: targetStatus,
          previousStatus,
          reviewerId,
          note,
          occurredAt: changedAt.toISOString(),
        });
        let nextProperties = {
          ...properties,
          review,
          reviewHistory,
          updatedAt: changedAt.toISOString(),
        };
        let enrichmentEvent: Record<string, unknown> | undefined;
        if (['APPROVED', 'CANDIDATE'].includes(targetStatus)) {
          const enrichment = queueLocationEnrichment(
            id,
            nextProperties,
            row.geometry,
            locationSnapshot(row),
            row.manual_location_fields,
            'LIFECYCLE_PROMOTED',
            reviewerId,
            true,
          );
          if (enrichment) {
            nextProperties = enrichment.properties;
            enrichmentEvent = enrichment.event;
          }
        }
        await client.query(
          `UPDATE geodata_entity SET lifecycle_status=$2,public_properties=$3::jsonb,updated_at=$4
           WHERE id=$1`,
          [
            id,
            targetStatus,
            stringifyJsonWithBigInts(nextProperties),
            changedAt,
          ],
        );
        const payload = {
          entityId: id,
          status: targetStatus,
          previousStatus,
          reviewerId,
          note,
        };
        await client.query(
          `INSERT INTO geodata_audit_event(event_id,aggregate_type,aggregate_id,event,occurred_at)
           VALUES ($1,'entity',$2,$3::jsonb,$4)`,
          [
            randomUUID(),
            id,
            stringifyJsonWithBigInts({
              eventType: 'geodata.entity.status-changed.v1',
              ...payload,
            }),
            changedAt,
          ],
        );
        await client.query(
          `INSERT INTO outbox_event
           (event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
           VALUES ($1,'geodata.entity.status-changed.v1','geodata-service','entity',$2,$3::jsonb,$4,$5)`,
          [
            randomUUID(),
            id,
            stringifyJsonWithBigInts(payload),
            changedAt,
            randomUUID(),
          ],
        );
        if (enrichmentEvent)
          await this.writeEntityEvent(
            client,
            id,
            'geodata.entity.location-enrichment-requested.v1',
            enrichmentEvent,
            changedAt,
          );
      }
      const current = await client.query(
        `SELECT ${entityProjection} AS entity FROM geodata_entity WHERE id=$1`,
        [id],
      );
      const response = current.rows[0]?.entity;
      if (key)
        await client.query(
          'INSERT INTO idempotency_record(service,key,response) VALUES ($1,$2,$3::jsonb)',
          [
            'geodata-entity-review',
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

  async patchEntityMetadata(
    id: string,
    key: string | undefined,
    ifMatch: string | undefined,
    body: Record<string, unknown>,
    claims: AccessTokenClaims,
    requestHash?: string,
  ) {
    if (key && requestHash) {
      const replay = await replayRequest(
        () => this.connect(),
        'geodata-entity-metadata',
        key,
        requestHash,
      );
      if (replay.found) return replay.response;
    }
    const editorId = body.editorId;
    if (!pythonTruthy(editorId))
      throw new BadRequestException('editorId is required');
    const supported = new Set([
      'editorId',
      'name',
      'website',
      'description',
      'location',
      'manualFields',
      'note',
    ]);
    const unknown = Object.keys(body).filter((field) => !supported.has(field));
    if (unknown.length)
      throw new BadRequestException(
        `unsupported entity metadata fields: ${unknown.sort().join(', ')}`,
      );
    if (
      !['name', 'website', 'description', 'location'].some(
        (field) => field in body,
      )
    )
      throw new BadRequestException(
        'at least one editable metadata field is required',
      );
    const note = body.note === undefined ? null : body.note;
    let name: string | undefined;
    if ('name' in body) {
      if (
        typeof body.name !== 'string' ||
        !trimPythonWhitespace(body.name) ||
        Array.from(trimPythonWhitespace(body.name)).length > 240
      )
        throw new BadRequestException('name must contain 1 to 240 characters');
      name = trimPythonWhitespace(body.name);
    }
    const website =
      'website' in body ? normalizeWebsite(body.website) : undefined;
    const description =
      'description' in body
        ? normalizeDescription(body.description)
        : undefined;
    let locationInput: Record<string, unknown> | undefined;
    let requestedManual: string[] | undefined;
    if ('location' in body) {
      if (!isRecord(body.location))
        throw new BadRequestException('location must be an object');
      const unknownLocation = Object.keys(body.location).filter(
        (field) => !(field in locationColumns),
      );
      if (unknownLocation.length)
        throw new BadRequestException(
          `unsupported location fields: ${unknownLocation.sort().join(', ')}`,
        );
      locationInput = body.location;
      const manual = body.manualFields ?? Object.keys(locationInput);
      if (
        !Array.isArray(manual) ||
        manual.some(
          (field) =>
            typeof field !== 'string' || !manualLocationFields.has(field),
        )
      )
        throw new BadRequestException(
          'manualFields must contain supported location fields',
        );
      requestedManual = [...new Set(manual as string[])].sort();
    }
    const expectedVersion = parseIfMatch(ifMatch);
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      if (key) await lockRequest(client, key);
      const result = await client.query(
        `SELECT id,revision,name,website,description,lifecycle_status,
          programme_slug,jurisdiction,entity_type_code,public_properties,
          ST_AsGeoJSON(geom)::jsonb AS geometry,
          continent,continent_code,country,country_code,region,region_code,
          subdivision,subdivision_code,province,province_code,county,county_code,
          city,municipality,locality,manual_location_fields
         FROM geodata_entity WHERE id=$1 FOR UPDATE`,
        [id],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundException('geodata entity not found');
      assertReviewCoverage(claims, row);
      if ('location' in body)
        assertGisAdminCoverage(claims, row, 'geodata.location.manage');
      if (key) {
        const previous = await readRequestResponse(
          client,
          'geodata-entity-metadata',
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
      const changed: Record<string, { previous: unknown; value: unknown }> = {};
      for (const [field, value] of Object.entries({
        name,
        website,
        description,
      })) {
        if (value !== undefined && value !== row[field])
          changed[field] = { previous: row[field], value };
      }
      let locationChanged = false;
      let nextLocation: Record<string, unknown> = {};
      let nextManual: string[] = [];
      let previousLocation: Record<string, unknown> = {};
      let releasedManualFields: string[] = [];
      if (locationInput && requestedManual) {
        const previousManual = Array.isArray(row.manual_location_fields)
          ? row.manual_location_fields.filter(
              (field: unknown): field is string => typeof field === 'string',
            )
          : [];
        nextManual = requestedManual;
        const released = previousManual.filter(
          (field: string) => !nextManual.includes(field),
        );
        releasedManualFields = released;
        const fieldNames = Object.keys(locationColumns);
        previousLocation = Object.fromEntries(
          fieldNames.map((field) => [field, row[locationColumns[field]]]),
        );
        nextLocation = { ...previousLocation };
        for (const field of nextManual) {
          if (field in locationInput)
            nextLocation[field] = normalizeManualLocationValue(
              field,
              locationInput[field],
            );
        }
        const catalogue = await client.query(
          `SELECT DISTINCT continent,continent_code,country,country_code,
            region,region_code,province,province_code FROM geodata_entity`,
        );
        const codes = deriveManualLocationCodes(
          nextLocation,
          new Set(nextManual),
          catalogue.rows,
        );
        Object.assign(nextLocation, codes);
        for (const field of released) nextLocation[field] = null;
        locationChanged =
          stringifyJsonWithBigInts(previousLocation) !==
            stringifyJsonWithBigInts(nextLocation) ||
          stringifyJsonWithBigInts(previousManual) !==
            stringifyJsonWithBigInts(nextManual);
      }
      if (Object.keys(changed).length || locationChanged) {
        await client.query(
          "SELECT set_config('myota.geodata_writer','row-v1',true)",
        );
        const properties = isRecord(row.public_properties)
          ? row.public_properties
          : {};
        const changedAt = new Date();
        const reviewHistory = Array.isArray(properties.reviewHistory)
          ? [...properties.reviewHistory]
          : [];
        const provenance = isRecord(properties.provenance)
          ? { ...properties.provenance }
          : {};
        if (changed.name)
          reviewHistory.push({
            action: 'ENTITY_NAME_CHANGED',
            editorId,
            previousName: changed.name.previous,
            name: changed.name.value,
            note,
            occurredAt: changedAt.toISOString(),
          });
        const metadataFields = Object.keys(changed)
          .filter((field) => field !== 'name')
          .sort();
        if (metadataFields.length)
          reviewHistory.push({
            action: 'ENTITY_METADATA_UPDATED',
            editorId,
            fields: metadataFields,
            note,
            occurredAt: changedAt.toISOString(),
          });
        if (locationChanged)
          reviewHistory.push({
            action: 'LOCATION_UPDATED',
            editorId,
            manualFields: nextManual,
            previous: previousLocation,
            location: nextLocation,
            note,
            occurredAt: changedAt.toISOString(),
          });
        if (locationChanged)
          provenance.manualLocation = {
            fields: nextManual,
            editorId,
            note,
            updatedAt: changedAt.toISOString(),
          };
        const propertyDelta: Record<string, unknown> = {
          reviewHistory,
          ...(locationChanged ? { provenance } : {}),
          updatedAt: changedAt.toISOString(),
        };
        const enrichment =
          locationChanged && releasedManualFields.length
            ? queueLocationEnrichment(
                id,
                { ...properties, ...propertyDelta },
                row.geometry,
                nextLocation,
                nextManual,
                'MANUAL_FIELDS_RELEASED',
                editorId,
                true,
              )
            : undefined;
        const updateParams: unknown[] = [
          id,
          name ?? null,
          'website' in body,
          website ?? null,
          'description' in body,
          description ?? null,
          stringifyJsonWithBigInts(enrichment?.properties ?? propertyDelta),
          changedAt,
        ];
        let updateSql = `UPDATE geodata_entity SET name=COALESCE($2,name),website=CASE WHEN $3 THEN $4 ELSE website END,
          description=CASE WHEN $5 THEN $6 ELSE description END,
          public_properties=public_properties || $7::jsonb,updated_at=$8`;
        if (enrichment) updateSql += ',location_work_dispatched_at=now()';
        if (locationChanged) {
          for (const [field, value] of Object.entries(nextLocation)) {
            if (!(field in locationColumns)) continue;
            updateParams.push(value);
            updateSql += `,${locationColumns[field]}=$${updateParams.length}`;
          }
          updateParams.push(stringifyJsonWithBigInts(nextManual), changedAt);
          updateSql += `,manual_location_fields=$${updateParams.length - 1}::jsonb,manual_location_updated_at=$${updateParams.length}`;
        }
        updateSql += ' WHERE id=$1';
        await client.query(updateSql, updateParams);
        if (locationChanged) {
          await this.writeEntityEvent(
            client,
            id,
            'geodata.entity.location-updated.v1',
            { entityId: id, editorId, manualFields: nextManual, note },
            changedAt,
          );
        }
        if (enrichment)
          await this.writeEntityEvent(
            client,
            id,
            'geodata.entity.location-enrichment-requested.v1',
            enrichment.event,
            new Date(enrichment.requestedAt),
          );
        if (changed.name)
          await this.writeEntityEvent(
            client,
            id,
            'geodata.entity.name-changed.v1',
            {
              entityId: id,
              editorId,
              previousName: changed.name.previous,
              name: changed.name.value,
              note,
            },
            changedAt,
          );
        const metadataChanges = Object.fromEntries(
          Object.entries(changed).filter(([field]) => field !== 'name'),
        );
        if (Object.keys(metadataChanges).length)
          await this.writeEntityEvent(
            client,
            id,
            'geodata.entity.metadata-updated.v1',
            {
              entityId: id,
              editorId,
              changes: metadataChanges,
              note,
            },
            changedAt,
          );
      }
      const current = await client.query(
        `SELECT ${entityProjection} AS entity FROM geodata_entity WHERE id=$1`,
        [id],
      );
      const response = current.rows[0]?.entity;
      if (key)
        await client.query(
          'INSERT INTO idempotency_record(service,key,response) VALUES ($1,$2,$3::jsonb)',
          [
            'geodata-entity-metadata',
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
        () => this.connect(),
        'geodata-location-enrichment',
        key,
        requestHash,
      );
      if (replay.found) return replay.response;
    }
    const editorId = body.editorId;
    if (!pythonTruthy(editorId))
      throw new BadRequestException('editorId is required');
    const expectedVersion = parseIfMatch(ifMatch);
    const client = await this.connect();
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
      if (!row) throw new NotFoundException('geodata entity not found');
      assertGisAdminCoverage(claims, row, 'geodata.location.manage');
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
      const requestedAt = new Date();
      const nextProperties = {
        ...properties,
        locationEnrichmentRequestId: requestId,
        locationEnrichmentGeometryHash: geometryHash,
        locationEnrichmentStatus: 'QUEUED',
        locationEnrichmentOnlyMissing: true,
        locationEnrichmentReason: 'ADMIN_REQUESTED_MISSING_METADATA',
        locationEnrichmentRequestedAt: requestedAt.toISOString(),
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
      await this.writeEntityEvent(
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

  async replaceEntityCategories(
    id: string,
    key: string | undefined,
    ifMatch: string | undefined,
    body: Record<string, unknown>,
    claims: AccessTokenClaims,
    requestHash?: string,
  ) {
    if (key && requestHash) {
      const replay = await replayRequest(
        () => this.connect(),
        'geodata-entity-categories',
        key,
        requestHash,
      );
      if (replay.found) return replay.response;
    }
    const editorId = body.editorId;
    if (!pythonTruthy(editorId))
      throw new BadRequestException('editorId is required');
    const rawTypes = firstTruthyCategoryInput([
      body.entityTypes,
      body.entityTypeCodes,
      body.entityType,
    ]);
    const entityTypes = normalizeEntityTypeCodes(rawTypes);
    if (
      !entityTypes.length ||
      entityTypes.some((code) => !/^[A-Z][A-Z0-9_]{1,63}$/.test(code))
    )
      throw new BadRequestException(
        'one or more valid entity type codes are required',
      );
    const note = body.note === undefined ? null : body.note;
    const expectedVersion = parseIfMatch(ifMatch);
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      if (key) await lockRequest(client, key);
      const selected = await client.query(
        `SELECT id,revision,lifecycle_status,programme_slug,jurisdiction,
          entity_type_code,public_properties
         FROM geodata_entity WHERE id=$1 FOR UPDATE`,
        [id],
      );
      const row = selected.rows[0];
      if (!row) throw new NotFoundException('geodata entity not found');
      assertReviewCoverage(claims, row);
      if (key) {
        const previous = await readRequestResponse(
          client,
          'geodata-entity-categories',
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
      if (row.lifecycle_status === 'RETIRED')
        throw new ConflictException('retired entities cannot change category');
      const currentCategories = await client.query(
        'SELECT category_code FROM geodata_entity_category WHERE entity_id=$1 ORDER BY ordinal',
        [id],
      );
      const previousTypes = currentCategories.rows.map((category) =>
        String(category.category_code),
      );
      if (
        stringifyJsonWithBigInts(previousTypes) !==
        stringifyJsonWithBigInts(entityTypes)
      ) {
        await client.query(
          "SELECT set_config('myota.geodata_writer','row-v1',true)",
        );
        const categoryIds: string[] = [];
        for (const code of entityTypes) {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('geodata:category:' || $1,0))",
            [code],
          );
          const found = await client.query(
            'SELECT id FROM entity_type WHERE programme_id IS NULL AND code=$1 LIMIT 1',
            [code],
          );
          let categoryId = found.rows[0]?.id as string | undefined;
          if (!categoryId) {
            categoryId = randomUUID();
            await client.query(
              `INSERT INTO entity_type(id,programme_id,code,label,geometry_kind,config)
               VALUES ($1,NULL,$2,$3,'GEOMETRY','{}'::jsonb)`,
              [categoryId, code, titleCode(code)],
            );
          }
          categoryIds.push(categoryId);
        }
        const properties = isRecord(row.public_properties)
          ? row.public_properties
          : {};
        const changedAt = new Date();
        const reviewHistory = Array.isArray(properties.reviewHistory)
          ? [...properties.reviewHistory]
          : [];
        reviewHistory.push({
          action: 'ENTITY_TYPE_CHANGED',
          editorId,
          previousEntityTypes: previousTypes,
          entityTypes,
          previousEntityType: previousTypes[0] ?? null,
          entityType: entityTypes[0],
          note,
          occurredAt: changedAt.toISOString(),
        });
        await client.query(
          `UPDATE geodata_entity SET entity_type_id=$2,entity_type_code=$3,
           public_properties=public_properties || $4::jsonb,updated_at=$5 WHERE id=$1`,
          [
            id,
            categoryIds[0],
            entityTypes[0],
            stringifyJsonWithBigInts({
              entityType: entityTypes[0],
              entityTypes,
              entityTypeCodes: entityTypes,
              reviewHistory,
              updatedAt: changedAt.toISOString(),
            }),
            changedAt,
          ],
        );
        await client.query(
          'DELETE FROM geodata_entity_category WHERE entity_id=$1',
          [id],
        );
        for (let index = 0; index < entityTypes.length; index++)
          await client.query(
            `INSERT INTO geodata_entity_category(entity_id,category_id,category_code,is_primary,ordinal)
             VALUES ($1,$2,$3,$4,$5)`,
            [id, categoryIds[index], entityTypes[index], index === 0, index],
          );
        await this.writeEntityEvent(
          client,
          id,
          'geodata.entity.entity-type-changed.v1',
          {
            entityId: id,
            editorId,
            previousEntityTypes: previousTypes,
            entityTypes,
            note,
          },
          changedAt,
        );
      }
      const response = await this.readEntityWithClient(client, id);
      if (key)
        await client.query(
          'INSERT INTO idempotency_record(service,key,response) VALUES ($1,$2,$3::jsonb)',
          [
            'geodata-entity-categories',
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
        () => this.connect(),
        'geodata-entity-geometry',
        key,
        requestHash,
      );
      if (replay.found) return replay.response;
    }
    const editorId = body.editorId;
    if (!pythonTruthy(editorId))
      throw new BadRequestException('editorId is required');
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
        error instanceof Error ? error.message : 'invalid geometry coordinates',
      );
    }
    const geometry = stringifyJsonWithBigInts({
      type: geometryType,
      coordinates: geometryInput.coordinates,
    });
    if (Buffer.byteLength(geometry) > 5 * 1024 * 1024)
      throw new BadRequestException('geometry exceeds the 5 MiB limit');
    const note = body.note === undefined ? null : body.note;
    const expectedVersion = parseIfMatch(ifMatch);
    const client = await this.connect();
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
      if (!row) throw new NotFoundException('geodata entity not found');
      assertReviewCoverage(claims, row);
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
      const changedAt = new Date();
      const geometryHistory = Array.isArray(properties.geometryHistory)
        ? [...properties.geometryHistory]
        : [];
      geometryHistory.push({
        editorId,
        note,
        geometry: row.geometry,
        editedAt: changedAt.toISOString(),
      });
      let nextProperties: Record<string, unknown> = {
        ...properties,
        geometryHistory,
        updatedAt: changedAt.toISOString(),
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
      await this.writeEntityEvent(
        client,
        id,
        'geodata.entity.geometry-updated.v1',
        { entityId: id, editorId, note, geometry: body.geometry },
        changedAt,
      );
      if (enrichment)
        await this.writeEntityEvent(
          client,
          id,
          'geodata.entity.location-enrichment-requested.v1',
          enrichment.event,
          new Date(enrichment.requestedAt),
        );
      const response = await this.readEntityWithClient(client, id);
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

  private async writeEntityEvent(
    client: import('pg').PoolClient,
    entityId: string,
    eventType: string,
    payload: Record<string, unknown>,
    occurredAt: Date,
  ) {
    await client.query(
      `INSERT INTO geodata_audit_event(event_id,aggregate_type,aggregate_id,event,occurred_at)
       VALUES ($1,'entity',$2,$3::jsonb,$4)`,
      [
        randomUUID(),
        entityId,
        stringifyJsonWithBigInts({ eventType, ...payload }),
        occurredAt,
      ],
    );
    await client.query(
      `INSERT INTO outbox_event
       (event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
       VALUES ($1,$2,'geodata-service','entity',$3,$4::jsonb,$5,$6)`,
      [
        randomUUID(),
        eventType,
        entityId,
        stringifyJsonWithBigInts(payload),
        occurredAt,
        randomUUID(),
      ],
    );
  }

  private async readEntityWithClient(client: PoolClient, id: string) {
    const result = await client.query(
      `SELECT ${entityProjection} AS entity FROM geodata_entity WHERE id=$1`,
      [id],
    );
    return result.rows[0]?.entity;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertReviewCoverage(
  claims: AccessTokenClaims,
  entity: Record<string, unknown>,
) {
  if (claims.scp.includes('*')) return;
  if (!claims.scp.includes('geodata.review'))
    throw new ForbiddenException('geodata.review scope is required');
  const properties = isRecord(entity.public_properties)
    ? entity.public_properties
    : {};
  const rawCategories = firstTruthyCategoryInput([
    properties.entityTypes,
    properties.entityTypeCodes,
    properties.entityType,
    entity.entity_type_codes,
    entity.entity_type_code,
  ]);
  const categories = normalizeEntityTypeCodes(rawCategories);
  const roles = claims.roles ?? [];
  const scopedRoles = roles.filter((role) => {
    const scopes = Array.isArray(role.scopes) ? role.scopes : [];
    return scopes.includes('geodata.review') || role.role === 'GLOBAL_OPERATOR';
  });
  for (const role of scopedRoles) {
    if (role.programmeSlug && role.programmeSlug !== entity.programme_slug)
      continue;
    if (role.entityType) {
      if (
        typeof role.entityType !== 'string' ||
        !categories.includes(role.entityType.toUpperCase())
      )
        continue;
    }
    if (role.jurisdiction && role.jurisdiction !== entity.jurisdiction)
      continue;
    return;
  }
  if (!roles.some((role) => role.role === 'GLOBAL_OPERATOR'))
    throw new ForbiddenException('approver scope does not cover this entity');
}

function assertGisAdminCoverage(
  claims: AccessTokenClaims,
  entity: Record<string, unknown>,
  permission: string,
) {
  if (claims.scp.includes('*')) return;
  const roles = claims.roles ?? [];
  if (
    roles.some((role) => {
      if (!['GIS_ADMIN', 'GLOBAL_OPERATOR'].includes(String(role.role)))
        return false;
      if (role.programmeSlug && role.programmeSlug !== entity.programme_slug)
        return false;
      if (role.jurisdiction && role.jurisdiction !== entity.jurisdiction)
        return false;
      return true;
    })
  )
    return;
  if (claims.scp.includes(permission)) return;
  throw new ForbiddenException(
    'global or GIS administrator access is required',
  );
}

function normalizeEntityTypeCodes(value: unknown): string[] {
  let raw = value;
  if (isRecord(raw)) raw = raw.code || raw.entityType;
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? [raw]
      : [];
  const result: string[] = [];
  for (const item of values) {
    const candidate = isRecord(item) ? item.code : item;
    const code =
      typeof candidate === 'string'
        ? trimPythonWhitespace(candidate).toUpperCase()
        : '';
    if (/^[A-Z][A-Z0-9_]{1,63}$/.test(code) && !result.includes(code))
      result.push(code);
  }
  return result;
}

function firstTruthyCategoryInput(values: unknown[]) {
  return values.find((value) => {
    if (value === null || value === undefined || value === false || value === 0)
      return false;
    if (typeof value === 'string') return value.length > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (isRecord(value)) return Object.keys(value).length > 0;
    return true;
  });
}

function normalizeManualLocationValue(field: string, value: unknown) {
  if (value === null) return null;
  if (
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    typeof value !== 'boolean'
  )
    throw new BadRequestException(
      `location field ${field} must be scalar or null`,
    );
  const normalized = trimPythonWhitespace(
    typeof value === 'boolean' ? (value ? 'True' : 'False') : String(value),
  );
  return field.endsWith('Code') ? normalized.toUpperCase() : normalized || null;
}

function deriveManualLocationCodes(
  location: Record<string, unknown>,
  manual: Set<string>,
  rows: Record<string, unknown>[],
) {
  const continents = buildManualLocationTree(rows);
  const continent = findLocationNode(continents, location.continent);
  const result: Record<string, unknown> = {};
  if (manual.has('continent')) {
    if (!continent)
      throw new BadRequestException(
        'continent must match the location catalogue',
      );
    result.continentCode = continent.code;
  }
  const countries = continent
    ? (continent.countries ?? [])
    : flattenLocationNodes(continents, 'countries');
  const country = findLocationNode(countries, location.country);
  if (manual.has('country')) {
    if (!country)
      throw new BadRequestException(
        'country must match the location catalogue',
      );
    result.countryCode = country.code;
  }
  const subdivisionValue = location.region || location.subdivision;
  const subdivisions = country
    ? (country.subdivisions ?? [])
    : flattenLocationNodes(countries, 'subdivisions');
  const subdivision = findLocationNode(subdivisions, subdivisionValue);
  if (manual.has('region') || manual.has('subdivision')) {
    if (!subdivision)
      throw new BadRequestException(
        'region or subdivision must match the location catalogue',
      );
    result.regionCode = subdivision.code;
    result.subdivisionCode = subdivision.code;
  }
  const provinces = subdivision
    ? (subdivision.provinces ?? [])
    : flattenLocationNodes(subdivisions, 'provinces');
  const province = findLocationNode(provinces, location.province);
  if (manual.has('province')) {
    if (!province)
      throw new BadRequestException(
        'province must match the location catalogue',
      );
    result.provinceCode = province.code;
  }
  return result;
}

type ManualLocationBuilderNode = {
  name: string;
  code: string | null;
  children: Map<string, ManualLocationBuilderNode>;
};

type ManualLocationNode = {
  name: string;
  code: string | null;
  countries?: ManualLocationNode[];
  subdivisions?: ManualLocationNode[];
  provinces?: ManualLocationNode[];
};

function buildManualLocationTree(rows: Record<string, unknown>[]) {
  const continents = new Map<string, ManualLocationBuilderNode>();
  const upsert = (
    nodes: Map<string, ManualLocationBuilderNode>,
    name: unknown,
    code: unknown,
  ) => {
    const label = textValue(name);
    if (!label) return null;
    const normalizedCode = normalizedLocationCode(code);
    const key = `${normalizedCode ?? ''}:${unicodeCaseFold(label)}`;
    let node = nodes.get(key);
    if (!node) {
      node = { name: label, code: normalizedCode, children: new Map() };
      nodes.set(key, node);
    } else if (!node.code && normalizedCode) {
      node.code = normalizedCode;
    }
    return node;
  };
  for (const row of rows) {
    const continent = upsert(continents, row.continent, row.continent_code);
    if (!continent) continue;
    const country = upsert(continent.children, row.country, row.country_code);
    if (!country) continue;
    const subdivision = upsert(country.children, row.region, row.region_code);
    if (!subdivision) continue;
    upsert(subdivision.children, row.province, row.province_code);
  }
  const sorted = (
    nodes: Map<string, ManualLocationBuilderNode>,
    childFields: ('countries' | 'subdivisions' | 'provinces')[],
  ): ManualLocationNode[] =>
    [...nodes.values()]
      .map((node) => {
        const result: ManualLocationNode = { name: node.name, code: node.code };
        const childField = childFields[0];
        if (childField) {
          result[childField] = sorted(node.children, childFields.slice(1));
        }
        return result;
      })
      .sort(
        (left, right) =>
          compareText(
            unicodeCaseFold(left.name),
            unicodeCaseFold(right.name),
          ) || compareText(left.code ?? '', right.code ?? ''),
      );
  return sorted(continents, ['countries', 'subdivisions', 'provinces']);
}

function findLocationNode(nodes: ManualLocationNode[], name: unknown) {
  const target = unicodeCaseFold(textValue(name));
  return target
    ? nodes.find((node) => unicodeCaseFold(node.name) === target)
    : undefined;
}

function flattenLocationNodes(
  nodes: ManualLocationNode[],
  childField: 'countries' | 'subdivisions' | 'provinces',
): ManualLocationNode[] {
  return nodes.flatMap((node) => {
    const children = node[childField] ?? [];
    return childField === 'provinces'
      ? children
      : [
          ...children,
          ...flattenLocationNodes(
            children,
            childField === 'countries' ? 'subdivisions' : 'provinces',
          ),
        ];
  });
}

function textValue(value: unknown) {
  return typeof value === 'string' ? trimPythonWhitespace(value) : '';
}

function normalizedLocationCode(value: unknown) {
  const code = textValue(value).toUpperCase();
  return code || null;
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseIfMatch(value: string | undefined) {
  if (value === undefined) return null;
  const match = /^"([0-9]+)"$/.exec(value);
  if (!match)
    throw new BadRequestException('If-Match must be a quoted entity version');
  return Number(match[1]);
}

function normalizeWebsite(value: unknown) {
  if (value === null) return null;
  if (typeof value !== 'string')
    throw new BadRequestException('website must be a string or null');
  const website = trimPythonWhitespace(value);
  if (!website) return null;
  if (Array.from(website).length > 2048)
    throw new BadRequestException('website must be 2048 characters or fewer');
  let parsed: URL;
  try {
    parsed = new URL(website);
  } catch {
    throw new BadRequestException(
      'website must be an absolute HTTP or HTTPS URL',
    );
  }
  const authority =
    website.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1] ?? '';
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    authority.includes('@')
  )
    throw new BadRequestException(
      'website must be an absolute HTTP or HTTPS URL',
    );
  return website;
}

function normalizeDescription(value: unknown) {
  if (value === null) return null;
  if (typeof value !== 'string')
    throw new BadRequestException('description must be a string or null');
  const description = trimPythonWhitespace(value);
  if (Array.from(description).length > 2000)
    throw new BadRequestException(
      'description must be 2000 characters or fewer',
    );
  return description || null;
}

function titleCode(code: string) {
  return code
    .replaceAll('_', ' ')
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
