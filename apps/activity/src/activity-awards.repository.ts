import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { stringifyJsonWithMetadata } from '@app/platform/json-bigint.js';
import { parseJsonWithExactIntegers } from '@app/platform/json-exact.js';
import { parsePageTotal, type PageInteger } from '@app/platform/pagination.js';
import { pythonKeyErrorDetail } from '@app/platform/python-strings.js';
import { normalizeTimestamp, type JsonRecord } from './activity-domain.js';
import { utcTimestamp } from '@app/platform/utc-timestamp.js';

const awardRequestTimestampProjection = `to_char(requested_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS requested_at_iso,
                   to_char(issued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS issued_at_iso`;
const awardRequestProjection = `${awardRequestTimestampProjection}, facts::text AS facts_text`;

@Injectable()
export class ActivityAwardsRepository {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async utcTimestamp(): Promise<string> {
    const client = await this.connect();
    try {
      return await utcTimestamp(client);
    } finally {
      client.release();
    }
  }

  async saveAwardDefinition(
    record: JsonRecord,
    key?: string,
    eventType?: string,
  ): Promise<JsonRecord> {
    return this.mutate(key, async (client) => {
      await client.query(
        `INSERT INTO activity_award_definition(id,programme_slug,code,version,status,effective_from,retired_at,definition)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         ON CONFLICT (id) DO UPDATE SET programme_slug=EXCLUDED.programme_slug,code=EXCLUDED.code,
         version=EXCLUDED.version,status=EXCLUDED.status,effective_from=EXCLUDED.effective_from,
         retired_at=EXCLUDED.retired_at,definition=EXCLUDED.definition,updated_at=now()`,
        [
          record.id,
          record.programmeSlug,
          record.code,
          Number(record.version ?? 1),
          record.status ?? 'DRAFT',
          record.effectiveFrom ? new Date(record.effectiveFrom) : null,
          record.retiredAt ? new Date(record.retiredAt) : null,
          stringifyJsonWithMetadata(record),
        ],
      );
      if (eventType)
        await this.event(
          client,
          eventType,
          'award',
          String(record.id),
          record,
          'awards',
        );
      return record;
    });
  }

  async listAwardDefinitionsPage(
    programme: string | undefined,
    category: string | undefined,
    publishedOnly: boolean,
    offset: bigint,
    pageSize: number,
  ): Promise<{ items: JsonRecord[]; total: PageInteger }> {
    const client = await this.connect();
    try {
      const filters: string[] = [];
      const values: unknown[] = [];
      if (programme) {
        values.push(programme);
        filters.push(`programme_slug=$${values.length}`);
      }
      if (category) {
        values.push(category);
        filters.push(`definition->>'category'=$${values.length}`);
      }
      if (publishedOnly) filters.push("status='PUBLISHED'");
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const offsetParameter = values.length + 1;
      values.push(offset.toString());
      const limitParameter = values.length + 1;
      values.push(pageSize);
      const result = await client.query(
        `SELECT total.value,page_rows.definition::text AS definition_text
         FROM (
           SELECT count(*) AS value
           FROM activity_award_definition
           ${where}
         ) total
         LEFT JOIN LATERAL (
           SELECT definition FROM activity_award_definition
           ${where}
           ORDER BY programme_slug,code,version
           LIMIT $${limitParameter} OFFSET $${offsetParameter}::bigint
         ) page_rows ON TRUE`,
        values,
      );
      return {
        items: result.rows
          .filter((row) => row.definition_text !== null)
          .map(
            (row) =>
              parseJsonWithExactIntegers(
                String(row.definition_text),
              ) as JsonRecord,
          ),
        total: parsePageTotal(result.rows[0]?.value ?? '0'),
      };
    } finally {
      client.release();
    }
  }

  async getAwardDefinition(id: string): Promise<JsonRecord> {
    const client = await this.connect();
    try {
      const result = await client.query(
        'SELECT definition::text AS definition_text FROM activity_award_definition WHERE id=$1',
        [id],
      );
      if (!result.rows[0])
        throw new NotFoundException(pythonKeyErrorDetail(id));
      return parseJsonWithExactIntegers(
        String(result.rows[0].definition_text),
      ) as JsonRecord;
    } finally {
      client.release();
    }
  }

  async getAwardAsset(id: string): Promise<JsonRecord> {
    const client = await this.connect();
    try {
      const result = await client.query(
        'SELECT metadata::text AS metadata_text FROM activity_asset WHERE id=$1',
        [id],
      );
      if (!result.rows[0])
        throw new NotFoundException(pythonKeyErrorDetail(id));
      return parseJsonWithExactIntegers(
        String(result.rows[0].metadata_text),
      ) as JsonRecord;
    } finally {
      client.release();
    }
  }

  async listAwardAssetsPage(
    offset: bigint,
    pageSize: number,
  ): Promise<{ items: JsonRecord[]; total: PageInteger }> {
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT total.value,page_rows.metadata::text AS metadata_text
         FROM (SELECT count(*) AS value FROM activity_asset) total
         LEFT JOIN LATERAL (
           SELECT metadata FROM activity_asset
           ORDER BY created_at
           LIMIT $2 OFFSET $1::bigint
         ) page_rows ON TRUE`,
        [offset.toString(), pageSize],
      );
      return {
        items: result.rows
          .filter((row) => row.metadata_text !== null)
          .map(
            (row) =>
              parseJsonWithExactIntegers(
                String(row.metadata_text),
              ) as JsonRecord,
          ),
        total: parsePageTotal(result.rows[0]?.value ?? '0'),
      };
    } finally {
      client.release();
    }
  }

  async findAwardAsset(
    kind: string,
    objectKey: string,
  ): Promise<JsonRecord | null> {
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT metadata::text AS metadata_text FROM activity_asset
         WHERE kind=$1 AND object_key=$2
         ORDER BY created_at,id LIMIT 1`,
        [kind, objectKey],
      );
      return result.rows[0]
        ? (parseJsonWithExactIntegers(
            String(result.rows[0].metadata_text),
          ) as JsonRecord)
        : null;
    } finally {
      client.release();
    }
  }

  async saveAwardAsset(asset: JsonRecord): Promise<JsonRecord> {
    const client = await this.connect();
    try {
      await client.query(
        `INSERT INTO activity_asset(id,kind,object_key,bucket,media_type,width_px,height_px,content_status,metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
         ON CONFLICT (id) DO UPDATE SET media_type=EXCLUDED.media_type,width_px=EXCLUDED.width_px,
         height_px=EXCLUDED.height_px,content_status=EXCLUDED.content_status,metadata=EXCLUDED.metadata,updated_at=now()`,
        [
          asset.id,
          asset.kind,
          asset.objectKey,
          asset.bucket,
          asset.mediaType,
          Number(asset.widthPx),
          Number(asset.heightPx),
          asset.contentStatus ?? 'MISSING',
          stringifyJsonWithMetadata(asset),
        ],
      );
      return asset;
    } finally {
      client.release();
    }
  }

  async createAwardRequest(
    record: JsonRecord,
  ): Promise<{ request: JsonRecord; created: boolean }> {
    return this.mutate(undefined, async (client) => {
      const result = await client.query(
        `INSERT INTO activity_award_request(id,award_id,programme_slug,level_id,subject_id,category,callsign,person_name,facts,status,requested_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'REQUESTED',$10)
         ON CONFLICT (award_id,level_id,subject_id) DO NOTHING RETURNING id`,
        [
          record.id,
          record.awardId,
          record.programmeSlug,
          record.levelId,
          record.subjectId,
          record.category,
          record.callsign,
          record.personName,
          stringifyJsonWithMetadata(record.facts ?? {}),
          new Date(String(record.requestedAt)),
        ],
      );
      const saved = await client.query(
        `SELECT *, ${awardRequestProjection}
         FROM activity_award_request WHERE award_id=$1 AND level_id=$2 AND subject_id=$3`,
        [record.awardId, record.levelId, record.subjectId],
      );
      const request = awardRequestRecord(saved.rows[0]);
      if (result.rows[0])
        await this.event(
          client,
          'awards.request.created.v1',
          'award_request',
          request.id,
          request,
          'awards',
        );
      return { request, created: result.rows.length > 0 };
    });
  }

  async listAwardRequestsPage(
    subjectId: string | undefined,
    offset: bigint,
    pageSize: number,
  ): Promise<{ items: JsonRecord[]; total: PageInteger }> {
    const client = await this.connect();
    try {
      const values: unknown[] = [];
      let where = '';
      if (subjectId) {
        values.push(subjectId);
        where = `WHERE r.subject_id=$${values.length}`;
      }
      const offsetParameter = values.length + 1;
      values.push(offset.toString());
      const limitParameter = values.length + 1;
      values.push(pageSize);
      const result = await client.query(
        `SELECT total.value,page_rows.*
         FROM (
           SELECT count(*) AS value FROM activity_award_request r ${where}
         ) total
         LEFT JOIN LATERAL (
           SELECT r.*, ${awardRequestProjection},
             COALESCE((i.issuance->'artifact'->>'downloadReady')::boolean,FALSE) AS artifact_ready
           FROM activity_award_request r
           LEFT JOIN activity_award_issuance i ON i.id=r.issued_award_id
           ${where}
           ORDER BY r.requested_at DESC
           LIMIT $${limitParameter} OFFSET $${offsetParameter}::bigint
         ) page_rows ON TRUE`,
        values,
      );
      return {
        items: result.rows
          .filter((row) => row.id !== null)
          .map(awardRequestRecord),
        total: parsePageTotal(result.rows[0]?.value ?? '0'),
      };
    } finally {
      client.release();
    }
  }

  async getAwardRequest(id: string): Promise<JsonRecord> {
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT *, ${awardRequestProjection}
         FROM activity_award_request WHERE id=$1`,
        [id],
      );
      if (!result.rows[0])
        throw new NotFoundException(pythonKeyErrorDetail(id));
      return awardRequestRecord(result.rows[0]);
    } finally {
      client.release();
    }
  }

  async issueAwardRequest(
    requestId: string,
    issuance: JsonRecord,
    key?: string,
  ): Promise<JsonRecord> {
    return this.mutate(key, async (client) => {
      const locked = await client.query(
        `SELECT *, ${awardRequestProjection}
         FROM activity_award_request WHERE id=$1 FOR UPDATE`,
        [requestId],
      );
      if (!locked.rows[0])
        throw new NotFoundException(pythonKeyErrorDetail(requestId));
      const request = awardRequestRecord(locked.rows[0]);
      if (request.status !== 'REQUESTED')
        throw new BadRequestException('only requested awards can be issued');
      await client.query(
        `INSERT INTO activity_award_issuance(id,request_id,award_id,programme_slug,level_id,subject_id,issuance)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [
          issuance.id,
          requestId,
          issuance.awardId,
          issuance.programmeSlug,
          issuance.levelId,
          issuance.subjectId,
          stringifyJsonWithMetadata(issuance),
        ],
      );
      await client.query(
        "UPDATE activity_award_request SET status='ISSUED',issued_award_id=$2,issued_at=$3 WHERE id=$1",
        [requestId, issuance.id, issuance.issuedAt],
      );
      await this.event(
        client,
        'awards.issued.v1',
        'award_issuance',
        issuance.id,
        issuance,
        'awards',
      );
      return issuance;
    });
  }

  async listAwardIssuancesPage(
    offset: bigint,
    pageSize: number,
  ): Promise<{ items: JsonRecord[]; total: PageInteger }> {
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT total.value,page_rows.issuance::text AS issuance_text,
                page_rows.render_job_status
         FROM (SELECT count(*) AS value FROM activity_award_issuance) total
         LEFT JOIN LATERAL (
           SELECT i.issuance,
                  render_job.status AS render_job_status
           FROM activity_award_issuance i
           LEFT JOIN LATERAL (
             SELECT j.status
             FROM activity_job j
             WHERE j.kind='PDF_RENDER' AND j.payload->>'issuanceId'=i.id::text
             ORDER BY j.created_at DESC,j.id DESC
             LIMIT 1
           ) render_job ON TRUE
           ORDER BY i.created_at DESC
           LIMIT $2 OFFSET $1::bigint
         ) page_rows ON TRUE`,
        [offset.toString(), pageSize],
      );
      return {
        items: result.rows
          .filter((row) => row.issuance_text !== null)
          .map((row) => ({
            ...(parseJsonWithExactIntegers(
              String(row.issuance_text),
            ) as JsonRecord),
            renderJobStatus: row.render_job_status ?? null,
          })),
        total: parsePageTotal(result.rows[0]?.value ?? '0'),
      };
    } finally {
      client.release();
    }
  }

  async getAwardIssuance(id: string): Promise<JsonRecord> {
    const client = await this.connect();
    try {
      const result = await client.query(
        'SELECT issuance::text AS issuance_text FROM activity_award_issuance WHERE id=$1',
        [id],
      );
      if (!result.rows[0])
        throw new NotFoundException(pythonKeyErrorDetail(id));
      return parseJsonWithExactIntegers(
        String(result.rows[0].issuance_text),
      ) as JsonRecord;
    } finally {
      client.release();
    }
  }

  private async connect(): Promise<PoolClient> {
    if (!this.pool)
      throw new ServiceUnavailableException(
        'Activity database is not configured',
      );
    try {
      return await this.pool.connect();
    } catch {
      throw new ServiceUnavailableException('Activity database is unavailable');
    }
  }

  private async mutate<T>(
    key: string | undefined,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      if (key) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('activity-service:' || $1,0))",
          [key],
        );
        const previous = await client.query(
          'SELECT response::text AS response_text FROM idempotency_record WHERE service=$1 AND key=$2',
          ['activity-service', key],
        );
        if (previous.rows[0]) {
          await client.query('COMMIT');
          return parseJsonWithExactIntegers(
            String(previous.rows[0].response_text),
          ) as T;
        }
      }
      const result = await operation(client);
      if (key)
        await client.query(
          'INSERT INTO idempotency_record(service,key,response) VALUES ($1,$2,$3::jsonb)',
          ['activity-service', key, stringifyJsonWithMetadata(result)],
        );
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async event(
    client: PoolClient,
    type: string,
    aggregate: string,
    id: string,
    payload: JsonRecord,
    producer = 'activity-service',
  ) {
    await client.query(
      `INSERT INTO outbox_event(event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
      VALUES ($1,$2,$7,$3,$4,$5::jsonb,now(),$6)`,
      [
        randomUUID(),
        type,
        aggregate,
        id,
        stringifyJsonWithMetadata(payload),
        randomUUID(),
        producer,
      ],
    );
  }
}

function timestamp(value: unknown) {
  return value == null ? null : normalizeTimestamp(value as string | Date);
}

function awardRequestRecord(row: any): JsonRecord {
  if (!row) throw new NotFoundException('award request not found');
  return {
    id: String(row.id),
    awardId: String(row.award_id),
    programmeSlug: row.programme_slug,
    levelId: row.level_id,
    subjectId: row.subject_id,
    category: row.category,
    callsign: row.callsign,
    personName: row.person_name,
    facts:
      row.facts_text == null
        ? row.facts
        : parseJsonWithExactIntegers(String(row.facts_text)),
    status: row.status,
    issuedAwardId: row.issued_award_id ? String(row.issued_award_id) : null,
    artifactReady: Boolean(row.artifact_ready),
    requestedAt: timestamp(row.requested_at_iso ?? row.requested_at),
    issuedAt: timestamp(row.issued_at_iso ?? row.issued_at),
  };
}
