import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { entityProjection } from './geodata.repository.js';

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
const manualLocationFields = new Set(
  Object.keys(locationColumns).filter((field) => !field.endsWith('Code')),
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
  ) {
    const reviewerId =
      typeof body.reviewerId === 'string' ? body.reviewerId.trim() : '';
    const targetStatus =
      typeof body.status === 'string'
        ? body.status.toUpperCase()
        : typeof body.decision === 'string'
          ? body.decision.toUpperCase()
          : '';
    const note =
      typeof body.note === 'string' ? body.note.slice(0, 2000) : null;
    if (!reviewerId) throw new BadRequestException('reviewerId is required');
    if (
      !['APPROVED', 'CANDIDATE', 'RETIRED', 'REJECTED'].includes(targetStatus)
    )
      throw new BadRequestException('unsupported entity review status');
    const expectedVersion = parseIfMatch(ifMatch);
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      if (key) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('geodata-entity-review:' || $1,0))",
          [key],
        );
        const previous = await client.query(
          'SELECT response FROM idempotency_record WHERE service=$1 AND key=$2',
          ['geodata-entity-review', key],
        );
        if (previous.rows[0]) {
          await client.query('COMMIT');
          return previous.rows[0].response;
        }
      }
      const result = await client.query(
        `SELECT id,revision,lifecycle_status,public_properties
         FROM geodata_entity WHERE id=$1 FOR UPDATE`,
        [id],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundException('geodata entity not found');
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
        const nextProperties = {
          ...properties,
          review,
          reviewHistory,
          updatedAt: changedAt.toISOString(),
        };
        await client.query(
          `UPDATE geodata_entity SET lifecycle_status=$2,public_properties=$3::jsonb,updated_at=$4
           WHERE id=$1`,
          [id, targetStatus, JSON.stringify(nextProperties), changedAt],
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
            JSON.stringify({
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
          [randomUUID(), id, JSON.stringify(payload), changedAt, randomUUID()],
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
          ['geodata-entity-review', key, JSON.stringify(response)],
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
  ) {
    const editorId =
      typeof body.editorId === 'string' ? body.editorId.trim() : '';
    if (!editorId) throw new BadRequestException('editorId is required');
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
      !['name', 'website', 'description', 'location', 'manualFields'].some(
        (field) => field in body,
      )
    )
      throw new BadRequestException(
        'at least one editable metadata field is required',
      );
    const note =
      typeof body.note === 'string' ? body.note.slice(0, 2000) : null;
    let name: string | undefined;
    if ('name' in body) {
      if (
        typeof body.name !== 'string' ||
        !body.name.trim() ||
        body.name.trim().length > 240
      )
        throw new BadRequestException('name must contain 1 to 240 characters');
      name = body.name.trim();
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
    } else if ('manualFields' in body) {
      throw new BadRequestException('manualFields requires a location object');
    }
    const expectedVersion = parseIfMatch(ifMatch);
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      if (key) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('geodata-entity-metadata:' || $1,0))",
          [key],
        );
        const previous = await client.query(
          'SELECT response FROM idempotency_record WHERE service=$1 AND key=$2',
          ['geodata-entity-metadata', key],
        );
        if (previous.rows[0]) {
          await client.query('COMMIT');
          return previous.rows[0].response;
        }
      }
      const result = await client.query(
        `SELECT id,revision,name,website,description,lifecycle_status,public_properties,
          continent,continent_code,country,country_code,region,region_code,
          subdivision,subdivision_code,province,province_code,county,county_code,
          city,municipality,locality,manual_location_fields
         FROM geodata_entity WHERE id=$1 FOR UPDATE`,
        [id],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundException('geodata entity not found');
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
          `SELECT DISTINCT continent,continent_code,country,country_code,region,region_code,
            subdivision,subdivision_code,province,province_code FROM geodata_entity`,
        );
        const codes = deriveManualLocationCodes(
          nextLocation,
          new Set(nextManual),
          catalogue.rows,
        );
        Object.assign(nextLocation, codes);
        for (const field of released) nextLocation[field] = null;
        locationChanged =
          JSON.stringify(previousLocation) !== JSON.stringify(nextLocation) ||
          JSON.stringify(previousManual) !== JSON.stringify(nextManual);
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
        const updateParams: unknown[] = [
          id,
          name ?? null,
          'website' in body,
          website ?? null,
          'description' in body,
          description ?? null,
          JSON.stringify({
            reviewHistory,
            ...(locationChanged ? { provenance } : {}),
            updatedAt: changedAt.toISOString(),
          }),
          changedAt,
        ];
        let updateSql = `UPDATE geodata_entity SET name=COALESCE($2,name),website=CASE WHEN $3 THEN $4 ELSE website END,
          description=CASE WHEN $5 THEN $6 ELSE description END,
          public_properties=public_properties || $7::jsonb,updated_at=$8`;
        if (locationChanged) {
          for (const [field, value] of Object.entries(nextLocation)) {
            if (!(field in locationColumns)) continue;
            updateParams.push(value);
            updateSql += `,${locationColumns[field]}=$${updateParams.length}`;
          }
          updateParams.push(JSON.stringify(nextManual), changedAt);
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
          ['geodata-entity-metadata', key, JSON.stringify(response)],
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

  async replaceEntityCategories(
    id: string,
    key: string | undefined,
    ifMatch: string | undefined,
    body: Record<string, unknown>,
  ) {
    const editorId =
      typeof body.editorId === 'string' ? body.editorId.trim() : '';
    if (!editorId) throw new BadRequestException('editorId is required');
    const rawTypes =
      body.entityTypes ?? body.entityTypeCodes ?? body.entityType;
    const entityTypes = (Array.isArray(rawTypes) ? rawTypes : [rawTypes])
      .map((value) =>
        typeof value === 'string' ? value.trim().toUpperCase() : '',
      )
      .filter(Boolean);
    if (
      !entityTypes.length ||
      entityTypes.some((code) => !/^[A-Z][A-Z0-9_]{1,63}$/.test(code))
    )
      throw new BadRequestException(
        'one or more valid entity type codes are required',
      );
    if (new Set(entityTypes).size !== entityTypes.length)
      throw new BadRequestException('entityTypes must be unique');
    const note =
      typeof body.note === 'string' ? body.note.slice(0, 2000) : null;
    const expectedVersion = parseIfMatch(ifMatch);
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      if (key) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('geodata-entity-categories:' || $1,0))",
          [key],
        );
        const previous = await this.idempotentResponse(
          client,
          'geodata-entity-categories',
          key,
        );
        if (previous.found) {
          await client.query('COMMIT');
          return previous.response;
        }
      }
      const selected = await client.query(
        `SELECT id,revision,lifecycle_status,entity_type_code,public_properties
         FROM geodata_entity WHERE id=$1 FOR UPDATE`,
        [id],
      );
      const row = selected.rows[0];
      if (!row) throw new NotFoundException('geodata entity not found');
      if (expectedVersion !== null && Number(row.revision) !== expectedVersion)
        throw new ConflictException('entity version is stale');
      if (row.lifecycle_status === 'RETIRED')
        throw new ConflictException('retired entities cannot change category');
      const currentCategories = await client.query(
        'SELECT category_code FROM geodata_entity_category WHERE entity_id=$1 ORDER BY is_primary DESC,category_code',
        [id],
      );
      const previousTypes = currentCategories.rows.map((category) =>
        String(category.category_code),
      );
      if (JSON.stringify(previousTypes) !== JSON.stringify(entityTypes)) {
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
            JSON.stringify({
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
            `INSERT INTO geodata_entity_category(entity_id,category_id,category_code,is_primary)
             VALUES ($1,$2,$3,$4)`,
            [id, categoryIds[index], entityTypes[index], index === 0],
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
        await this.saveIdempotentResponse(
          client,
          'geodata-entity-categories',
          key,
          response,
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
  ) {
    const editorId =
      typeof body.editorId === 'string' ? body.editorId.trim() : '';
    if (!editorId) throw new BadRequestException('editorId is required');
    if (
      !isRecord(body.geometry) ||
      ![
        'Point',
        'LineString',
        'MultiLineString',
        'Polygon',
        'MultiPolygon',
      ].includes(String(body.geometry.type)) ||
      !('coordinates' in body.geometry)
    )
      throw new BadRequestException(
        'geometry must be a supported GeoJSON geometry',
      );
    const geometry = JSON.stringify(body.geometry);
    if (Buffer.byteLength(geometry) > 5 * 1024 * 1024)
      throw new BadRequestException('geometry exceeds the 5 MiB limit');
    const note =
      typeof body.note === 'string' ? body.note.slice(0, 2000) : null;
    const expectedVersion = parseIfMatch(ifMatch);
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      if (key) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('geodata-entity-geometry:' || $1,0))",
          [key],
        );
        const previous = await this.idempotentResponse(
          client,
          'geodata-entity-geometry',
          key,
        );
        if (previous.found) {
          await client.query('COMMIT');
          return previous.response;
        }
      }
      const selected = await client.query(
        `SELECT id,revision,ST_AsGeoJSON(geom)::jsonb AS geometry,public_properties
         FROM geodata_entity WHERE id=$1 FOR UPDATE`,
        [id],
      );
      const row = selected.rows[0];
      if (!row) throw new NotFoundException('geodata entity not found');
      if (expectedVersion !== null && Number(row.revision) !== expectedVersion)
        throw new ConflictException('entity version is stale');
      const checked = await client.query(
        `SELECT ST_IsValid(g) AS valid,ST_IsEmpty(g) AS empty,
          ST_XMin(Box3D(g)) AS min_x,ST_XMax(Box3D(g)) AS max_x,
          ST_YMin(Box3D(g)) AS min_y,ST_YMax(Box3D(g)) AS max_y
         FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1),4326) AS g) input`,
        [geometry],
      );
      const bounds = checked.rows[0];
      if (
        !bounds?.valid ||
        bounds.empty ||
        Number(bounds.min_x) < -180 ||
        Number(bounds.max_x) > 180 ||
        Number(bounds.min_y) < -90 ||
        Number(bounds.max_y) > 90
      )
        throw new BadRequestException(
          'geometry must be valid and within WGS84 bounds',
        );
      if (JSON.stringify(row.geometry) !== geometry) {
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
        await client.query(
          `UPDATE geodata_entity SET geom=ST_SetSRID(ST_GeomFromGeoJSON($2),4326),
           centroid=ST_Centroid(ST_SetSRID(ST_GeomFromGeoJSON($2),4326))::geography,
           public_properties=public_properties || $3::jsonb,updated_at=$4 WHERE id=$1`,
          [
            id,
            geometry,
            JSON.stringify({
              geometryHistory,
              updatedAt: changedAt.toISOString(),
            }),
            changedAt,
          ],
        );
        await this.writeEntityEvent(
          client,
          id,
          'geodata.entity.geometry-updated.v1',
          { entityId: id, editorId, note, geometry: body.geometry },
          changedAt,
        );
      }
      const response = await this.readEntityWithClient(client, id);
      if (key)
        await this.saveIdempotentResponse(
          client,
          'geodata-entity-geometry',
          key,
          response,
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
        JSON.stringify({ eventType, ...payload }),
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
        JSON.stringify(payload),
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

  private async idempotentResponse(
    client: PoolClient,
    service: string,
    key: string,
  ) {
    const result = await client.query(
      'SELECT response FROM idempotency_record WHERE service=$1 AND key=$2',
      [service, key],
    );
    return result.rows[0]
      ? { found: true, response: result.rows[0].response }
      : { found: false as const, response: undefined };
  }

  private async saveIdempotentResponse(
    client: PoolClient,
    service: string,
    key: string,
    response: unknown,
  ) {
    await client.query(
      'INSERT INTO idempotency_record(service,key,response) VALUES ($1,$2,$3::jsonb)',
      [service, key, JSON.stringify(response)],
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  const normalized = String(value).trim();
  return field.endsWith('Code') ? normalized.toUpperCase() : normalized || null;
}

function deriveManualLocationCodes(
  location: Record<string, unknown>,
  manual: Set<string>,
  rows: Record<string, unknown>[],
) {
  const matches = (field: string, value: unknown) =>
    rows.filter(
      (row) =>
        textValue(row[field]).toLocaleLowerCase() ===
        textValue(value).toLocaleLowerCase(),
    );
  const result: Record<string, unknown> = {};
  const continentRows = matches('continent', location.continent);
  if (manual.has('continent')) {
    if (!textValue(location.continent) || !continentRows.length)
      throw new BadRequestException(
        'continent must match the location catalogue',
      );
    result.continentCode = continentRows[0].continent_code ?? null;
  }
  const countryRows = rows.filter(
    (row) =>
      textValue(row.country).toLocaleLowerCase() ===
        textValue(location.country).toLocaleLowerCase() &&
      (!location.continent || sameText(row.continent, location.continent)),
  );
  if (manual.has('country')) {
    if (!textValue(location.country) || !countryRows.length)
      throw new BadRequestException(
        'country must match the location catalogue',
      );
    result.countryCode = countryRows[0].country_code ?? null;
  }
  const subdivisionValue = location.region || location.subdivision;
  const subdivisionRows = rows.filter(
    (row) =>
      textValue(row.region || row.subdivision).toLocaleLowerCase() ===
        textValue(subdivisionValue).toLocaleLowerCase() &&
      (!location.country || sameText(row.country, location.country)),
  );
  if (manual.has('region') || manual.has('subdivision')) {
    if (!subdivisionRows.length)
      throw new BadRequestException(
        'region or subdivision must match the location catalogue',
      );
    result.regionCode =
      subdivisionRows[0].region_code ??
      subdivisionRows[0].subdivision_code ??
      null;
    result.subdivisionCode =
      subdivisionRows[0].subdivision_code ??
      subdivisionRows[0].region_code ??
      null;
  }
  const provinceRows = rows.filter(
    (row) =>
      textValue(row.province).toLocaleLowerCase() ===
        textValue(location.province).toLocaleLowerCase() &&
      (!location.country || sameText(row.country, location.country)) &&
      (!subdivisionValue ||
        sameText(row.region || row.subdivision, subdivisionValue)),
  );
  if (manual.has('province')) {
    if (!textValue(location.province) || !provinceRows.length)
      throw new BadRequestException(
        'province must match the location catalogue',
      );
    result.provinceCode = provinceRows[0].province_code ?? null;
  }
  return result;
}

function textValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function sameText(left: unknown, right: unknown) {
  return (
    textValue(left).toLocaleLowerCase() === textValue(right).toLocaleLowerCase()
  );
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
  const website = value.trim();
  if (!website) return null;
  if (website.length > 2048)
    throw new BadRequestException('website must be 2048 characters or fewer');
  let parsed: URL;
  try {
    parsed = new URL(website);
  } catch {
    throw new BadRequestException(
      'website must be an absolute HTTP or HTTPS URL',
    );
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
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
  const description = value.trim();
  if (description.length > 2000)
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
