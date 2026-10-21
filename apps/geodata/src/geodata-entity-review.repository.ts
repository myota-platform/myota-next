import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AccessTokenClaims } from '@app/platform/access-token.js';
import { pythonKeyErrorDetail } from '@app/platform/python-strings.js';
import { utcTimestamp } from '@app/platform/utc-timestamp.js';
import {
  firstPythonTruthy,
  pythonTruthy,
} from '@app/platform/python-truthiness.js';
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
  parseIfMatch,
} from './geodata-entity-mutation.helpers.js';
import { GeodataEntityMutationSupport } from './geodata-entity-mutation-support.js';
import { entityProjection } from './geodata.repository.js';

@Injectable()
export class GeodataEntityReviewRepository {
  constructor(private readonly support: GeodataEntityMutationSupport) {}

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
        () => this.support.connect(),
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
    if (!pythonTruthy(requestedStatus))
      throw new BadRequestException('review status or decision is required');
    const expectedVersion = parseIfMatch(ifMatch);
    const client = await this.support.connect();
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
      if (!row) throw new NotFoundException(pythonKeyErrorDetail(id));
      assertReviewCoverage(claims, row);
      if (!pythonTruthy(reviewerId))
        throw new BadRequestException('reviewerId is required');
      if (
        !['APPROVED', 'CANDIDATE', 'RETIRED', 'REJECTED'].includes(targetStatus)
      )
        throw new BadRequestException('unsupported entity review status');
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
        const changedAt = await utcTimestamp(client);
        const review = {
          ...(isRecord(properties.review) ? properties.review : {}),
          reviewerId,
          note,
          changedAt: changedAt,
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
          occurredAt: changedAt,
        });
        let nextProperties = {
          ...properties,
          review,
          reviewHistory,
          updatedAt: changedAt,
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
            await utcTimestamp(client),
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
          await this.support.writeEntityEvent(
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
}
