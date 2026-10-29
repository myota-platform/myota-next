import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { AccessTokenClaims } from '@app/platform/access-token.js';
import {
  allocateProgrammeEntityIdentifier,
  ProgrammeEntityIdentifierError,
  suggestProgrammeEntityIdentifier,
  type ManualEntityIdentifierAssignment,
} from '../../geodata-worker/src/programme-entity-identifier.js';
import { loadProgrammePolicy } from '../../geodata-worker/src/programme-policy-client.js';
import {
  locationColumns,
  manualLocationFields,
  assertReviewCoverage,
  isRecord,
  normalizeDescription,
  normalizeManualLocationValue,
  normalizeWebsite,
  titleCode,
} from './geodata-entity-mutation.helpers.js';
import {
  lockRequest,
  readRequestResponse,
  replayRequest,
  requestResponse,
} from './geodata-request-idempotency.js';
import { GeodataEntityMutationSupport } from './geodata-entity-mutation-support.js';
import { queueLocationEnrichment } from './geodata-location-enrichment.js';

const CREATE_FIELDS = new Set([
  'name',
  'programmeSlug',
  'entityTypeCodes',
  'geometry',
  'location',
  'website',
  'description',
  'jurisdiction',
  'qualifier',
  'serial',
]);

@Injectable()
export class GeodataEntityCreationRepository {
  constructor(private readonly support: GeodataEntityMutationSupport) {}

  async previewIdentifier(
    body: Record<string, unknown>,
    claims: AccessTokenClaims,
  ) {
    const programmeSlug = requiredText(body.programmeSlug, 'programmeSlug');
    const entityTypeCode = requiredText(
      body.entityTypeCode,
      'entityTypeCode',
    ).toUpperCase();
    const location = normalizeLocation(body.location);
    assertReviewCoverage(claims, {
      programme_slug: programmeSlug,
      entity_type_code: entityTypeCode,
      jurisdiction: null,
    });
    const programme = await loadProgrammePolicy(programmeSlug).catch(() => {
      throw new ServiceUnavailableException(
        'programme configuration is unavailable',
      );
    });
    if (!programme.entityTypeCodes.includes(entityTypeCode))
      throw new BadRequestException(
        'entity type is not configured for the selected programme',
      );
    const policy = programme.entityNumbering;
    if (!policy) return { entityIdentifier: null, assignmentMode: null };
    const properties = { location };
    const manual: ManualEntityIdentifierAssignment = {};
    if (body.qualifier !== undefined) manual.qualifier = body.qualifier;
    const client = await this.support.connect();
    try {
      const first = suggestProgrammeEntityIdentifier(
        { ...policy, assignmentMode: 'MANUAL' },
        properties,
        manual,
        1,
      );
      const scope = first.qualifier ?? '';
      const programmeWide = policy.assignmentMode === 'PROGRAMME_SEQUENCE';
      const result = await client.query<{ next_serial: number | string }>(
        programmeWide
          ? `SELECT COALESCE(MAX(serial_number),0)+1 AS next_serial
               FROM geodata_entity_identifier_reservation
              WHERE programme_slug=$1`
          : `SELECT COALESCE(MAX(serial_number),0)+1 AS next_serial
               FROM geodata_entity_identifier_reservation
              WHERE programme_slug=$1
                AND (qualifier_scope=$2 OR qualifier_scope='')`,
        programmeWide ? [programmeSlug] : [programmeSlug, scope],
      );
      const preview = suggestProgrammeEntityIdentifier(
        { ...policy, assignmentMode: 'MANUAL' },
        properties,
        manual,
        Number(result.rows[0]?.next_serial ?? 1),
      );
      return {
        ...preview,
        assignmentMode: policy.assignmentMode,
        reserved: false,
      };
    } catch (error) {
      if (error instanceof ProgrammeEntityIdentifierError)
        throw new BadRequestException(error.message);
      throw error;
    } finally {
      client.release();
    }
  }

  async create(
    key: string | undefined,
    body: Record<string, unknown>,
    claims: AccessTokenClaims,
    requestHash?: string,
  ) {
    if (key && requestHash) {
      const replay = await replayRequest(
        () => this.support.connect(),
        'geodata-entity-create',
        key,
        requestHash,
      );
      if (replay.found) return replay.response;
    }
    const unknown = Object.keys(body).filter(
      (field) => !CREATE_FIELDS.has(field),
    );
    if (unknown.length)
      throw new BadRequestException(
        `unsupported entity creation fields: ${unknown.sort().join(', ')}`,
      );
    const name = requiredText(body.name, 'name').trim();
    if (!name || Array.from(name).length > 240)
      throw new BadRequestException('name must be 1 to 240 characters');
    const programmeSlug = requiredText(body.programmeSlug, 'programmeSlug');
    const rawCodes = body.entityTypeCodes;
    if (!Array.isArray(rawCodes) || !rawCodes.length)
      throw new BadRequestException('entityTypeCodes must not be empty');
    const entityTypeCodes = [
      ...new Set(
        rawCodes.map((code) =>
          requiredText(code, 'entityTypeCodes').toUpperCase(),
        ),
      ),
    ];
    if (entityTypeCodes.some((code) => !/^[A-Z][A-Z0-9_]{1,63}$/.test(code)))
      throw new BadRequestException('entityTypeCodes contains an invalid code');
    const entityTypeCode = entityTypeCodes[0]!;
    const geometry = body.geometry;
    if (!isRecord(geometry) || typeof geometry.type !== 'string')
      throw new BadRequestException('geometry must be a GeoJSON Geometry');
    const location = normalizeLocation(body.location);
    const website = normalizeWebsite(body.website ?? null);
    const description = normalizeDescription(body.description ?? null);
    const jurisdiction = optionalText(body.jurisdiction, 'jurisdiction');
    const manualAssignment: ManualEntityIdentifierAssignment = {};
    if (body.qualifier !== undefined)
      manualAssignment.qualifier = body.qualifier;
    if (body.serial !== undefined) manualAssignment.serial = body.serial;
    assertReviewCoverage(claims, {
      programme_slug: programmeSlug,
      entity_type_codes: entityTypeCodes,
      jurisdiction,
    });
    const programme = await loadProgrammePolicy(programmeSlug).catch(() => {
      throw new ServiceUnavailableException(
        'programme configuration is unavailable',
      );
    });
    if (
      entityTypeCodes.some((code) => !programme.entityTypeCodes.includes(code))
    )
      throw new BadRequestException(
        'entity type is not configured for the selected programme',
      );

    const id = randomUUID();
    const sourceKey = `manual:${id}`;
    const sourceHash = createHash('sha256')
      .update(
        stringifyJsonWithBigInts({
          name,
          programmeSlug,
          entityTypeCodes,
          geometry,
          location,
          website,
          description,
          jurisdiction,
        }),
      )
      .digest('hex');
    const manualFields = Object.keys(location).filter(
      (field) => manualLocationFields.has(field) && location[field] != null,
    );
    const properties: Record<string, unknown> = {
      id,
      programmeSlug,
      entityType: entityTypeCode,
      entityTypes: entityTypeCodes,
      entityTypeCodes,
      geometry,
      location,
      website,
      description,
      sourceRef: id,
      sourceState: 'CURRENT',
      provenance: {
        adapter: 'MANUAL',
        sourceKey,
        sourceHash,
        createdBy: claims.sub,
      },
      review: null,
      reviewHistory: [],
    };
    const client = await this.support.connect();
    try {
      await client.query('BEGIN');
      if (key) await lockRequest(client, key);
      if (key) {
        const previous = await readRequestResponse(
          client,
          'geodata-entity-create',
          key,
          requestHash,
        );
        if (previous.found) {
          await client.query('COMMIT');
          return previous.response;
        }
      }
      const geometryCheck = await client
        .query<{ valid: boolean; empty: boolean }>(
          `SELECT ST_IsValid(g) AS valid,ST_IsEmpty(g) AS empty
             FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1),4326) AS g) input`,
          [stringifyJsonWithBigInts(geometry)],
        )
        .catch((error: unknown) => {
          if (
            isRecord(error) &&
            ['22P02', '22023'].includes(String(error.code))
          )
            throw new BadRequestException(
              'geometry must be a valid GeoJSON geometry',
            );
          throw error;
        });
      if (!geometryCheck.rows[0]?.valid || geometryCheck.rows[0]?.empty)
        throw new BadRequestException(
          'geometry must be a non-empty, valid GeoJSON geometry',
        );
      const categoryIds = new Map<string, string>();
      for (const code of entityTypeCodes) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('geodata:category:' || $1,0))",
          [code],
        );
        const found = await client.query<{ id: string }>(
          'SELECT id FROM entity_type WHERE programme_id IS NULL AND code=$1 LIMIT 1',
          [code],
        );
        let categoryId = found.rows[0]?.id;
        if (!categoryId) {
          categoryId = randomUUID();
          await client.query(
            `INSERT INTO entity_type(id,programme_id,code,label,geometry_kind,config)
             VALUES ($1,NULL,$2,$3,'GEOMETRY','{}'::jsonb)`,
            [categoryId, code, titleCode(code)],
          );
        }
        categoryIds.set(code, categoryId);
      }
      const category = await client.query<{ id: string; code: string }>(
        'SELECT id::text,code FROM entity_type WHERE programme_id IS NULL AND code=ANY($1::text[])',
        [entityTypeCodes],
      );
      for (const row of category.rows) categoryIds.set(row.code, row.id);
      if (entityTypeCodes.some((code) => !categoryIds.has(code)))
        throw new BadRequestException('entity type is unavailable');
      const categoryId = categoryIds.get(entityTypeCode)!;

      let entityIdentifier: string | null = null;
      if (programme.entityNumbering) {
        try {
          entityIdentifier = await allocateProgrammeEntityIdentifier(
            client,
            programmeSlug,
            programme.entityNumbering,
            id,
            properties,
            null,
            manualAssignment,
          );
        } catch (error) {
          if (error instanceof ProgrammeEntityIdentifierError)
            throw new ConflictException(error.message);
          throw error;
        }
      }
      properties.entityIdentifier = entityIdentifier;
      const occurredAt = await client.query('SELECT now() AS now');
      const createdAt = occurredAt.rows[0]?.now;
      properties.reviewHistory = [
        {
          action: 'CREATED',
          actor: claims.sub,
          occurredAt: createdAt,
        },
      ];
      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      const columns = Object.values(locationColumns);
      const locationValues = Object.keys(locationColumns).map((field) =>
        field in location
          ? normalizeManualLocationValue(field, location[field])
          : null,
      );
      const firstLocationParameter = 15;
      const locationColumnsSql = columns.map((column) => `,${column}`).join('');
      const locationValuesSql = columns
        .map((_, index) => `,$${firstLocationParameter + index}`)
        .join('');
      await client.query(
        `INSERT INTO geodata_entity
          (id,entity_type_id,name,lifecycle_status,geom,centroid,public_properties,
           source_state,source_key,source_hash,jurisdiction,attachments,programme_slug,
           entity_type_code,website,description,manual_location_fields,entity_identifier
           ${locationColumnsSql})
         SELECT $1,$2,$3,'CANDIDATE',g,ST_Centroid(g)::geography,$4::jsonb,
           'CURRENT',$5,$6,$7,'[]'::jsonb,$8,$9,$10,$11,$12::jsonb,$13
           ${locationValuesSql}
           FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($14),4326) AS g) input`,
        [
          id,
          categoryId,
          name,
          stringifyJsonWithBigInts(properties),
          sourceKey,
          sourceHash,
          jurisdiction,
          programmeSlug,
          entityTypeCode,
          website,
          description,
          stringifyJsonWithBigInts(manualFields),
          entityIdentifier,
          stringifyJsonWithBigInts(geometry),
          ...locationValues,
        ],
      );
      for (let ordinal = 0; ordinal < entityTypeCodes.length; ordinal++) {
        const code = entityTypeCodes[ordinal]!;
        await client.query(
          `INSERT INTO geodata_entity_category(entity_id,category_id,category_code,is_primary,ordinal)
           VALUES ($1,$2,$3,$4,$5)`,
          [id, categoryIds.get(code), code, ordinal === 0, ordinal],
        );
      }
      await client.query(
        `INSERT INTO source_reference
          (id,entity_id,adapter_code,source_record_id,source_payload)
         VALUES ($1,$2,'MANUAL',$3,$4::jsonb)`,
        [
          randomUUID(),
          id,
          id,
          stringifyJsonWithBigInts({ geometry, properties }),
        ],
      );
      const locationEnrichment = queueLocationEnrichment(
        id,
        properties,
        geometry,
        location,
        manualFields,
        'LIFECYCLE_CREATED',
        claims.sub,
        true,
        createdAt,
      );
      if (locationEnrichment) {
        Object.assign(properties, locationEnrichment.properties);
        await client.query(
          'UPDATE geodata_entity SET public_properties=$2::jsonb,location_work_dispatched_at=now() WHERE id=$1',
          [id, stringifyJsonWithBigInts(properties)],
        );
        await this.support.writeEntityEvent(
          client,
          id,
          'geodata.entity.location-enrichment-requested.v1',
          locationEnrichment.event,
          locationEnrichment.requestedAt,
        );
      }
      const event = {
        entityId: id,
        entityIdentifier,
        status: 'CANDIDATE',
        actor: claims.sub,
        programmeSlug,
        entityTypeCode,
        entityTypeCodes,
        source: 'MANUAL',
      };
      await this.support.writeEntityEvent(
        client,
        id,
        'geodata.entity.manual-created.v1',
        event,
        createdAt,
      );
      const entity = await this.support.readEntityWithClient(client, id);
      if (key)
        await client.query(
          'INSERT INTO idempotency_record(service,key,response) VALUES ($1,$2,$3::jsonb)',
          [
            'geodata-entity-create',
            key,
            stringifyJsonWithBigInts(requestResponse(entity, requestHash)),
          ],
        );
      await client.query('COMMIT');
      return entity;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function requiredText(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim())
    throw new BadRequestException(`${field} is required`);
  return value.trim();
}

function optionalText(value: unknown, field: string) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string')
    throw new BadRequestException(`${field} must be text`);
  return value.trim() || null;
}

function normalizeLocation(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value))
    throw new BadRequestException('location must be an object');
  const unknown = Object.keys(value).filter(
    (field) => !(field in locationColumns),
  );
  if (unknown.length)
    throw new BadRequestException(
      `unsupported location fields: ${unknown.sort().join(', ')}`,
    );
  return Object.fromEntries(
    Object.entries(value).map(([field, item]) => [
      field,
      normalizeManualLocationValue(field, item),
    ]),
  );
}
