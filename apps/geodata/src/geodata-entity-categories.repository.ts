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
import { pythonTruthy } from '@app/platform/python-truthiness.js';
import {
  lockRequest,
  readRequestResponse,
  replayRequest,
  requestResponse,
} from './geodata-request-idempotency.js';
import {
  assertReviewCoverage,
  firstTruthyCategoryInput,
  isRecord,
  normalizeEntityTypeCodes,
  parseIfMatch,
  titleCode,
} from './geodata-entity-mutation.helpers.js';
import { GeodataEntityMutationSupport } from './geodata-entity-mutation-support.js';

@Injectable()
export class GeodataEntityCategoryRepository {
  constructor(private readonly support: GeodataEntityMutationSupport) {}

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
        () => this.support.connect(),
        'geodata-entity-categories',
        key,
        requestHash,
      );
      if (replay.found) return replay.response;
    }
    const editorId = body.editorId;
    const rawTypes = firstTruthyCategoryInput([
      body.entityTypes,
      body.entityTypeCodes,
      body.entityType,
    ]);
    const entityTypes = normalizeEntityTypeCodes(rawTypes);
    const note = body.note === undefined ? null : body.note;
    const expectedVersion = parseIfMatch(ifMatch);
    const client = await this.support.connect();
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
      if (!row) throw new NotFoundException(pythonKeyErrorDetail(id));
      assertReviewCoverage(claims, row);
      if (!pythonTruthy(editorId))
        throw new BadRequestException('editorId is required');
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
      if (
        !entityTypes.length ||
        entityTypes.some((code) => !/^[A-Z][A-Z0-9_]{1,63}$/.test(code))
      )
        throw new BadRequestException(
          'one or more valid entity type codes are required',
        );
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
        const changedAt = await utcTimestamp(client);
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
          occurredAt: changedAt,
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
              updatedAt: changedAt,
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
        await this.support.writeEntityEvent(
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
      const response = await this.support.readEntityWithClient(client, id);
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
}
