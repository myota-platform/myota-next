import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AccessTokenClaims } from '@app/platform/access-token.js';
import {
  pythonKeyErrorDetail,
  pythonStringJsonField,
  trimPythonWhitespace,
} from '@app/platform/python-strings.js';
import { utcTimestamp } from '@app/platform/utc-timestamp.js';
import { pythonTruthy } from '@app/platform/python-truthiness.js';
import { queueLocationEnrichment } from './geodata-location-enrichment.js';
import {
  lockRequest,
  readRequestResponse,
  replayRequest,
  requestResponse,
} from './geodata-request-idempotency.js';
import {
  assertGisAdminCoverage,
  assertReviewCoverage,
  deriveManualLocationCodes,
  isRecord,
  locationColumns,
  manualLocationFields,
  normalizeDescription,
  normalizeManualLocationValue,
  normalizeWebsite,
  parseIfMatch,
} from './geodata-entity-mutation.helpers.js';
import { GeodataEntityMutationSupport } from './geodata-entity-mutation-support.js';
import { entityProjection } from './geodata.repository.js';

@Injectable()
export class GeodataEntityMetadataRepository {
  constructor(private readonly support: GeodataEntityMutationSupport) {}

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
        () => this.support.connect(),
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
      if (!pythonTruthy(body.name))
        throw new BadRequestException('missing required fields: name');
      name = trimPythonWhitespace(pythonStringJsonField(body, 'name'));
      if (!name) throw new BadRequestException('name must not be empty');
      if (Array.from(name).length > 240)
        throw new BadRequestException('name must be 240 characters or fewer');
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
      const manual = Object.hasOwn(body, 'manualFields')
        ? body.manualFields
        : Object.keys(locationInput);
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
    const client = await this.support.connect();
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
      if (!row) throw new NotFoundException(pythonKeyErrorDetail(id));
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
      if (Object.keys(changed).length || locationInput !== undefined) {
        await client.query(
          "SELECT set_config('myota.geodata_writer','row-v1',true)",
        );
        const properties = isRecord(row.public_properties)
          ? row.public_properties
          : {};
        const changedAt = await utcTimestamp(client);
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
            occurredAt: changedAt,
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
            occurredAt: changedAt,
          });
        if (locationInput !== undefined)
          reviewHistory.push({
            action: 'LOCATION_UPDATED',
            editorId,
            manualFields: nextManual,
            previous: previousLocation,
            location: nextLocation,
            note,
            occurredAt: changedAt,
          });
        if (locationInput !== undefined)
          provenance.manualLocation = {
            fields: nextManual,
            editorId,
            note,
            updatedAt: changedAt,
          };
        const propertyDelta: Record<string, unknown> = {
          reviewHistory,
          ...(locationInput !== undefined ? { provenance } : {}),
          updatedAt: changedAt,
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
                await utcTimestamp(client),
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
        if (locationInput !== undefined && requestedManual) {
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
        if (locationInput !== undefined) {
          await this.support.writeEntityEvent(
            client,
            id,
            'geodata.entity.location-updated.v1',
            { entityId: id, editorId, manualFields: nextManual, note },
            changedAt,
          );
        }
        if (enrichment)
          await this.support.writeEntityEvent(
            client,
            id,
            'geodata.entity.location-enrichment-requested.v1',
            enrichment.event,
            enrichment.requestedAt,
          );
        if (changed.name)
          await this.support.writeEntityEvent(
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
          await this.support.writeEntityEvent(
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
}
