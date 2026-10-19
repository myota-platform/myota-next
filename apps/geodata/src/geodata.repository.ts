import {
  Inject,
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';

@Injectable()
export class GeodataRepository {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async listEntities(query: Record<string, unknown>) {
    const filters: string[] = [];
    const values: unknown[] = [];
    const add = (fragment: string, value: unknown) => {
      values.push(value);
      filters.push(fragment.replace('?', `$${values.length}`));
    };
    if (query.programme) add('programme_slug=?', query.programme);
    const statuses = listValues(query.status)
      .flatMap((value) => value.split(','))
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean);
    if (statuses.length && !statuses.includes('ALL'))
      add('lifecycle_status=ANY(?::text[])', statuses);
    if (query.entityType)
      add(
        `EXISTS (SELECT 1 FROM geodata_entity_category c WHERE c.entity_id=geodata_entity.id AND lower(c.category_code)=lower(?))`,
        query.entityType,
      );
    for (const field of ['continent', 'country', 'region', 'province'])
      if (query[field])
        add(`lower(COALESCE(${field},''))=lower(?)`, query[field]);
    if (query.city) {
      values.push(query.city, query.city);
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
    const page = positiveInteger(query.page, 1);
    const pageSize = Math.min(100, positiveInteger(query.pageSize, 50));
    const client = await this.connect();
    try {
      const counted = await client.query(
        `SELECT count(*)::integer AS total FROM geodata_entity WHERE ${where}`,
        values,
      );
      const offset = (page - 1) * pageSize;
      const rows = await client.query(
        `SELECT ${entityProjection} AS entity FROM geodata_entity
         WHERE ${where} ORDER BY lower(name),id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, pageSize, offset],
      );
      const total = Number(counted.rows[0]?.total ?? 0);
      return {
        items: rows.rows.map((row) => row.entity),
        page,
        pageSize,
        total,
        nextPage: page * pageSize < total ? page + 1 : null,
      };
    } finally {
      client.release();
    }
  }

  async getEntity(id: string) {
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT ${entityProjection} AS entity FROM geodata_entity WHERE id=$1`,
        [id],
      );
      if (!result.rows[0])
        throw new NotFoundException('geodata entity not found');
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
    const page = positiveInteger(query.page, 1);
    const pageSize = Math.min(100, positiveInteger(query.pageSize, 50));
    const client = await this.connect();
    try {
      const counted = await client.query(
        'SELECT count(*)::integer AS total FROM import_run',
      );
      const rows = await client.query(
        `SELECT ${importProjection} AS run FROM import_run ORDER BY started_at DESC,id LIMIT $1 OFFSET $2`,
        [pageSize, (page - 1) * pageSize],
      );
      const total = Number(counted.rows[0]?.total ?? 0);
      return {
        items: rows.rows.map((row) => row.run),
        page,
        pageSize,
        total,
        nextPage: page * pageSize < total ? page + 1 : null,
      };
    } finally {
      client.release();
    }
  }

  async getImport(id: string) {
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT ${importProjection} AS run FROM import_run WHERE id=$1`,
        [id],
      );
      if (!result.rows[0])
        throw new NotFoundException('geodata import not found');
      return result.rows[0].run;
    } finally {
      client.release();
    }
  }

  async listImportCandidates(runId: string, query: Record<string, unknown>) {
    const page = positiveInteger(query.page, 1);
    const pageSize = Math.min(100, positiveInteger(query.pageSize, 50));
    const client = await this.connect();
    try {
      const counted = await client.query(
        "SELECT count(*)::integer AS total FROM geodata_import_candidate WHERE import_run_id=$1 AND validation_status='PENDING'",
        [runId],
      );
      const result = await client.query(
        `SELECT ${candidateProjection} AS candidate
         FROM geodata_import_candidate WHERE import_run_id=$1 AND validation_status='PENDING'
         ORDER BY ordinal,id LIMIT $2 OFFSET $3`,
        [runId, pageSize, (page - 1) * pageSize],
      );
      const total = Number(counted.rows[0]?.total ?? 0);
      return {
        items: result.rows.map((row) => row.candidate),
        page,
        pageSize,
        total,
        nextPage: page * pageSize < total ? page + 1 : null,
      };
    } finally {
      client.release();
    }
  }

  async validateImportCandidates(
    runId: string,
    key: string | undefined,
    body: Record<string, unknown>,
  ) {
    const candidateIds = body.candidateIds;
    const reviewerId =
      typeof body.reviewerId === 'string' ? body.reviewerId.trim() : '';
    if (
      !Array.isArray(candidateIds) ||
      !candidateIds.length ||
      candidateIds.some((id) => typeof id !== 'string' || !isUuid(id))
    )
      throw new BadRequestException(
        'candidateIds must be a non-empty list of UUIDs',
      );
    if (new Set(candidateIds).size !== candidateIds.length)
      throw new BadRequestException('candidateIds must be unique');
    if (!reviewerId) throw new BadRequestException('reviewerId is required');
    const requested =
      typeof body.validationStatus === 'string'
        ? body.validationStatus.toUpperCase()
        : 'VALID';
    if (!['VALID', 'CONFIRMED', 'REJECTED', 'INVALID'].includes(requested))
      throw new BadRequestException(
        'validationStatus must be VALID or REJECTED',
      );
    const rejected = requested === 'REJECTED' || requested === 'INVALID';
    const note =
      typeof body.note === 'string' ? body.note.slice(0, 2000) : null;
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      if (key) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('geodata-candidate-validation:' || $1,0))",
          [key],
        );
        const previous = await client.query(
          'SELECT response FROM idempotency_record WHERE service=$1 AND key=$2',
          ['geodata-candidate-validation', key],
        );
        if (previous.rows[0]) {
          await client.query('COMMIT');
          return previous.rows[0].response;
        }
      }
      const selected = await client.query(
        `SELECT id,validation_status,processing_queue_id
         FROM geodata_import_candidate WHERE import_run_id=$1 AND id=ANY($2::uuid[])
         FOR UPDATE`,
        [runId, candidateIds],
      );
      if (selected.rows.length !== candidateIds.length)
        throw new BadRequestException(
          'one or more candidates do not belong to this import run',
        );
      if (rejected && selected.rows.some((row) => row.processing_queue_id))
        throw new BadRequestException('queued candidates cannot be rejected');

      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      if (rejected) {
        await client.query(
          'DELETE FROM geodata_import_candidate WHERE import_run_id=$1 AND id=ANY($2::uuid[])',
          [runId, candidateIds],
        );
      } else {
        await client.query(
          `UPDATE geodata_import_candidate SET validation_status='CONFIRMED',
           validation_note=$3,validated_by=$4,validated_at=now(),updated_at=now()
           WHERE import_run_id=$1 AND id=ANY($2::uuid[]) AND validation_status<>'PROCESSED'`,
          [runId, candidateIds, note, reviewerId],
        );
      }
      const eventType = rejected
        ? 'geodata.import.candidates.rejected.v1'
        : 'geodata.import.candidates.validated.v1';
      await client.query(
        `INSERT INTO outbox_event
         (event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
         VALUES ($1,$2,'geodata-service','import_run',$3,$4::jsonb,now(),$5)`,
        [
          randomUUID(),
          eventType,
          runId,
          JSON.stringify({ importRunId: runId, candidateIds, reviewerId }),
          randomUUID(),
        ],
      );
      const response = {
        importRunId: runId,
        candidateIds,
        validationStatus: rejected ? 'REJECTED' : 'CONFIRMED',
      };
      if (key)
        await client.query(
          'INSERT INTO idempotency_record(service,key,response) VALUES ($1,$2,$3::jsonb)',
          ['geodata-candidate-validation', key, JSON.stringify(response)],
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

  async queueImportProcessing(
    runId: string,
    key: string | undefined,
    body: Record<string, unknown>,
  ) {
    const rawIds = body.candidateIds;
    if (
      !Array.isArray(rawIds) ||
      !rawIds.length ||
      rawIds.length > 500 ||
      rawIds.some((id) => typeof id !== 'string' || !isUuid(id))
    )
      throw new BadRequestException('candidateIds must contain 1 to 500 UUIDs');
    if (new Set(rawIds).size !== rawIds.length)
      throw new BadRequestException('candidateIds must be unique');
    const targetStatus =
      typeof body.targetStatus === 'string'
        ? body.targetStatus.toUpperCase()
        : '';
    if (!['CANDIDATE', 'APPROVED'].includes(targetStatus))
      throw new BadRequestException(
        'targetStatus must be CANDIDATE or APPROVED',
      );
    const requestedBy =
      typeof body.processorId === 'string' ? body.processorId.trim() : '';
    if (!requestedBy) throw new BadRequestException('processorId is required');
    const note =
      typeof body.note === 'string' ? body.note.slice(0, 2000) : null;
    const queueId = randomUUID();
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      if (key) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('geodata-import-promotion:' || $1,0))",
          [key],
        );
        const previous = await client.query(
          'SELECT response FROM idempotency_record WHERE service=$1 AND key=$2',
          ['geodata-import-promotion', key],
        );
        if (previous.rows[0]) {
          await client.query('COMMIT');
          return previous.rows[0].response;
        }
      }
      const selected = await client.query(
        `SELECT id,validation_status,processing_queue_id
         FROM geodata_import_candidate WHERE import_run_id=$1 AND id=ANY($2::uuid[])
         FOR UPDATE`,
        [runId, rawIds],
      );
      if (selected.rows.length !== rawIds.length)
        throw new BadRequestException(
          'one or more candidates do not belong to this import run',
        );
      if (
        selected.rows.some(
          (row) =>
            row.validation_status === 'PROCESSED' || row.processing_queue_id,
        )
      )
        throw new BadRequestException(
          'one or more candidates are already processed or queued',
        );

      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await client.query(
        `INSERT INTO geodata_import_processing_queue
          (id,import_run_id,candidate_ids,target_status,requested_by,status,job_metadata)
         VALUES ($1,$2,$3::jsonb,$4,$5,'QUEUED',$6::jsonb)`,
        [
          queueId,
          runId,
          JSON.stringify(rawIds),
          targetStatus,
          requestedBy,
          JSON.stringify({ note }),
        ],
      );
      await client.query(
        `UPDATE geodata_import_candidate SET validation_status='CONFIRMED',
         validated_by=$3,validated_at=now(),target_status=$4,processing_queue_id=$5,updated_at=now()
         WHERE import_run_id=$1 AND id=ANY($2::uuid[])`,
        [runId, rawIds, requestedBy, targetStatus, queueId],
      );
      await client.query(
        `INSERT INTO outbox_event
         (event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
         VALUES ($1,'geodata.import.processing.queued.v1','geodata-service','import_processing_queue',$2,$3::jsonb,now(),$4)`,
        [
          randomUUID(),
          queueId,
          JSON.stringify({
            queueId,
            importRunId: runId,
            candidateIds: rawIds,
            targetStatus,
            requestedBy,
            natsSubject: 'myota.geodata.import.process.v1',
          }),
          randomUUID(),
        ],
      );
      const response = {
        id: queueId,
        importRunId: runId,
        candidateIds: rawIds,
        targetStatus,
        requestedBy,
        status: 'QUEUED',
        requestedAt: new Date().toISOString(),
        queued: true,
      };
      if (key)
        await client.query(
          'INSERT INTO idempotency_record(service,key,response) VALUES ($1,$2,$3::jsonb)',
          ['geodata-import-promotion', key, JSON.stringify(response)],
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

  async getImportProcessingQueue(runId: string, queueId: string) {
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT id,import_run_id,candidate_ids,target_status,requested_by,status,
          requested_at,started_at,completed_at,result
         FROM geodata_import_processing_queue WHERE id=$1 AND import_run_id=$2`,
        [queueId, runId],
      );
      const row = result.rows[0];
      if (!row)
        throw new NotFoundException('import processing queue not found');
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
      'note',
    ]);
    const unknown = Object.keys(body).filter((field) => !supported.has(field));
    if (unknown.length)
      throw new BadRequestException(
        `unsupported entity metadata fields: ${unknown.sort().join(', ')}`,
      );
    if (!['name', 'website', 'description'].some((field) => field in body))
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
        `SELECT id,revision,name,website,description,lifecycle_status,public_properties
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
      if (Object.keys(changed).length) {
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
        await client.query(
          `UPDATE geodata_entity SET name=COALESCE($2,name),website=CASE WHEN $3 THEN $4 ELSE website END,
           description=CASE WHEN $5 THEN $6 ELSE description END,
           public_properties=public_properties || $7::jsonb,updated_at=$8 WHERE id=$1`,
          [
            id,
            name ?? null,
            'website' in body,
            website ?? null,
            'description' in body,
            description ?? null,
            JSON.stringify({
              reviewHistory,
              updatedAt: changedAt.toISOString(),
            }),
            changedAt,
          ],
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

  async getTile(zoom: number, x: number, y: number) {
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
    const client = await this.connect();
    try {
      const result = await client.query(
        `WITH bounds AS (SELECT ST_TileEnvelope($1,$2,$3) AS geom),
         tile_features AS (
           SELECT e.id,e.name,e.lifecycle_status AS status,e.programme_slug,
             e.entity_type_code,ST_AsMVTGeom(ST_Transform(e.geom,3857),bounds.geom) AS geom
           FROM geodata_entity e CROSS JOIN bounds
           WHERE e.lifecycle_status='APPROVED'
             AND ST_Transform(e.geom,3857) && bounds.geom
         )
         SELECT ST_AsMVT(tile_features,'geodata',4096,'geom') AS tile FROM tile_features`,
        [zoom, x, y],
      );
      return result.rows[0]?.tile
        ? Buffer.from(result.rows[0].tile)
        : Buffer.alloc(0);
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

const entityProjection = `public_properties || jsonb_build_object(
  'id',id::text,'programmeSlug',programme_slug,'entityType',entity_type_code,
  'name',name,'website',website,'description',description,'status',lifecycle_status,
  'geometry',ST_AsGeoJSON(geom)::jsonb,
  'centroid',jsonb_build_object('lon',ST_X(COALESCE(centroid,ST_Centroid(geom)::geography)::geometry),'lat',ST_Y(COALESCE(centroid,ST_Centroid(geom)::geography)::geometry)),
  'maidenheadGridSquares4',maidenhead_grid_squares_4,'maidenheadLocators6',maidenhead_locators_6,
  'sourceState',source_state,'jurisdiction',jurisdiction,'attachments',attachments,'version',revision,
  'categories',COALESCE((SELECT jsonb_agg(category_code ORDER BY category_code) FROM geodata_entity_category c WHERE c.entity_id=geodata_entity.id),'[]'::jsonb),
  'location',jsonb_build_object('continent',continent,'continentCode',continent_code,
    'country',country,'countryCode',country_code,'region',region,'regionCode',region_code,
    'subdivision',subdivision,'subdivisionCode',subdivision_code,'province',province,
    'provinceCode',province_code,'county',county,'countyCode',county_code,'city',city,
    'municipality',municipality,'locality',locality)
)`;

const importProjection = `source_metadata || jsonb_build_object(
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
  'existingEntityId',existing_entity_id,'name',name,'entityTypes',entity_type_codes,
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
    'locality',COALESCE(entity_payload->'locality',entity_payload->'location'->'locality'))`;

function listValues(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : typeof value === 'string'
      ? [value]
      : [];
}

function positiveInteger(value: unknown, fallback: number) {
  const number = Number.parseInt(typeof value === 'string' ? value : '', 10);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function parseBounds(query: Record<string, unknown>) {
  let raw: number[];
  if (typeof query.bbox === 'string' && query.bbox) {
    raw = query.bbox.split(',').map(Number);
  } else {
    const names = ['minLon', 'minLat', 'maxLon', 'maxLat'];
    if (!names.some((name) => query[name] !== undefined)) return null;
    raw = names.map((name) => Number(query[name]));
  }
  if (
    raw.length !== 4 ||
    raw.some((value) => !Number.isFinite(value)) ||
    raw[0] < -180 ||
    raw[0] >= raw[2] ||
    raw[2] > 180 ||
    raw[1] < -90 ||
    raw[1] >= raw[3] ||
    raw[3] > 90
  )
    throw new BadRequestException(
      'map bounds must have minimum values below maximum values',
    );
  return raw;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
