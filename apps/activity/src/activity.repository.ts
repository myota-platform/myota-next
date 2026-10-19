import {
  Inject,
  Injectable,
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import {
  evaluateActivation,
  normalizeTimestamp,
  type JsonRecord,
} from './activity-domain.js';

const activationTimestampProjection = `to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at_iso,
  to_char(ended_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ended_at_iso,
  to_char(validity_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS validity_expires_at_iso`;
const qsoTimestampProjection = `to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at_iso`;

@Injectable()
export class ActivityRepository {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async list(programme?: string, operatorId?: string) {
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT *, ${activationTimestampProjection} FROM activity_activation${programme || operatorId ? ' WHERE ' : ''}${programme ? 'programme_slug=$1' : ''}${programme && operatorId ? ' AND ' : ''}${operatorId ? `operator_id=$${programme ? 2 : 1}` : ''} ORDER BY started_at DESC`,
        [programme, operatorId].filter((v) => v !== undefined),
      );
      return result.rows.map((row) => activationRecord(row));
    } finally {
      client.release();
    }
  }

  async leaderboard(programme: string, category: string, limit = 50) {
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT subject_id,qso_count,activation_count,unique_callsign_count,unique_entity_count
         FROM activity_subject_aggregate WHERE programme_slug=$1 AND category=$2
         ORDER BY qso_count DESC,subject_id LIMIT $3`,
        [programme, category, limit],
      );
      return result.rows;
    } finally {
      client.release();
    }
  }

  async listStatistics(programme?: string): Promise<JsonRecord[]> {
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT id,programme_slug,statistic_type,scope_key,metric_values,algorithm_version,generated_at
         FROM activity_statistic_snapshot${programme ? ' WHERE programme_slug=$1' : ''} ORDER BY generated_at DESC`,
        programme ? [programme] : [],
      );
      return result.rows.map((row) => ({
        id: String(row.id),
        programme: row.programme_slug,
        type: row.statistic_type,
        scope: row.scope_key,
        values: row.metric_values,
        algorithmVersion: row.algorithm_version,
        generatedAt: date(row.generated_at),
      }));
    } finally {
      client.release();
    }
  }

  async listNotifications(recipientId: string): Promise<JsonRecord[]> {
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT id,recipient_id,notification_type,payload,status,created_at,delivered_at
         FROM activity_notification WHERE recipient_id=$1 ORDER BY created_at DESC`,
        [recipientId],
      );
      return result.rows.map((row) => ({
        id: String(row.id),
        recipientId: row.recipient_id,
        type: row.notification_type,
        payload: row.payload,
        status: row.status,
        createdAt: date(row.created_at),
        deliveredAt: date(row.delivered_at),
      }));
    } finally {
      client.release();
    }
  }

  async get(id: string): Promise<JsonRecord> {
    const client = await this.connect();
    try {
      return await this.getWithClient(client, id);
    } finally {
      client.release();
    }
  }

  async entityDeletionImpact(entityId: string): Promise<JsonRecord> {
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT
          (SELECT count(*)::integer FROM activity_qso q
           JOIN activity_activation a ON a.id=q.activation_id
           WHERE q.status<>'VOID' AND (q.worked_entity_id=$1 OR a.entity_id=$1)) AS qso_count,
          (SELECT count(*)::integer FROM activity_activation WHERE entity_id=$1) AS activation_count,
          (SELECT count(*)::integer FROM activity_award_progress p
           JOIN activity_award_definition d ON d.id=p.award_id
           WHERE p.subject_id IN (SELECT DISTINCT operator_id FROM activity_activation WHERE entity_id=$1)
              OR p.subject_id IN (SELECT DISTINCT hunter_id FROM activity_qso WHERE worked_entity_id=$1 AND hunter_id IS NOT NULL)) AS award_progress_count`,
        [entityId],
      );
      const row = result.rows[0];
      return {
        entityId,
        qsoCount: Number(row.qso_count),
        activationCount: Number(row.activation_count),
        awardProgressCount: Number(row.award_progress_count),
      };
    } finally {
      client.release();
    }
  }

  async cascadeDeleteEntity(
    entityId: string,
    deletedBy: string,
    key?: string,
  ): Promise<JsonRecord> {
    return this.mutate(key, async (client) => {
      const qsos = await client.query(
        `SELECT q.id,q.activation_id,q.operator_id,q.hunter_id,q.programme_slug
         FROM activity_qso q JOIN activity_activation a ON a.id=q.activation_id
         WHERE q.status<>'VOID' AND (q.worked_entity_id=$1 OR a.entity_id=$1)
         FOR UPDATE OF q`,
        [entityId],
      );
      const activations = await client.query(
        'SELECT id,operator_id,programme_slug FROM activity_activation WHERE entity_id=$1 FOR UPDATE',
        [entityId],
      );
      const subjectIds = new Set<string>();
      const programmes = new Set<string>();
      const affectedActivationIds = new Set<string>();
      for (const row of activations.rows) {
        subjectIds.add(String(row.operator_id));
        programmes.add(String(row.programme_slug));
        affectedActivationIds.add(String(row.id));
      }
      for (const row of qsos.rows) {
        subjectIds.add(String(row.operator_id));
        if (row.hunter_id) subjectIds.add(String(row.hunter_id));
        programmes.add(String(row.programme_slug));
        affectedActivationIds.add(String(row.activation_id));
      }
      const qsoIds = qsos.rows.map((row) => String(row.id));
      if (qsoIds.length) {
        await client.query(
          'DELETE FROM activity_qso_correction WHERE qso_id=ANY($1::uuid[])',
          [qsoIds],
        );
        await client.query(
          'DELETE FROM activity_qso WHERE id=ANY($1::uuid[])',
          [qsoIds],
        );
      }
      await client.query(
        `UPDATE activity_activation SET
         status=CASE WHEN entity_id=$1 THEN 'CLOSED_INVALID' ELSE status END,
         qso_count=(SELECT count(*) FROM activity_qso q WHERE q.activation_id=activity_activation.id AND q.status<>'VOID'),
         unique_callsign_count=(SELECT count(DISTINCT q.worked_callsign) FROM activity_qso q WHERE q.activation_id=activity_activation.id AND q.status<>'VOID'),
         unique_entity_count=(SELECT count(DISTINCT q.worked_entity_id) FROM activity_qso q WHERE q.activation_id=activity_activation.id AND q.status<>'VOID'),
         updated_at=now()
         WHERE entity_id=$1 OR id=ANY($2::uuid[])`,
        [entityId, [...affectedActivationIds]],
      );
      await this.rebuildSubjectAggregates(client, [...subjectIds]);
      const awardRecalculationJobs: string[] = [];
      for (const programmeSlug of programmes) {
        if (!programmeSlug) continue;
        const jobIdempotencyKey = `entity-delete-awards:${entityId}:${programmeSlug}`;
        await this.job(
          client,
          'AWARD_RECALCULATE',
          {
            programmeSlug,
            subjectIds: [...subjectIds].sort(),
            reason: 'ENTITY_DELETED',
            entityId,
          },
          jobIdempotencyKey,
        );
        const job = await client.query(
          'SELECT id FROM activity_job WHERE idempotency_key=$1',
          [jobIdempotencyKey],
        );
        if (job.rows[0]) awardRecalculationJobs.push(String(job.rows[0].id));
      }
      const result = {
        entityId,
        deletedBy,
        qsoCount: qsoIds.length,
        activationCount: activations.rows.length,
        awardRecalculationJobs,
      };
      await this.event(
        client,
        'activity.entity.cascade-deleted.v1',
        'entity',
        entityId,
        result,
      );
      return result;
    });
  }

  async getQso(id: string): Promise<JsonRecord> {
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT *, ${qsoTimestampProjection} FROM activity_qso WHERE id=$1`,
        [id],
      );
      if (!result.rows[0]) throw new NotFoundException('QSO not found');
      return qsoRecord(result.rows[0]);
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
          JSON.stringify(record),
        ],
      );
      if (eventType)
        await this.event(
          client,
          eventType,
          'award',
          String(record.id),
          record,
          'awards-service',
        );
      return record;
    });
  }

  async listAwardDefinitions(): Promise<JsonRecord[]> {
    const client = await this.connect();
    try {
      const result = await client.query(
        'SELECT definition FROM activity_award_definition ORDER BY programme_slug,code,version',
      );
      return result.rows.map((row) => row.definition);
    } finally {
      client.release();
    }
  }

  async getAwardDefinition(id: string): Promise<JsonRecord> {
    const client = await this.connect();
    try {
      const result = await client.query(
        'SELECT definition FROM activity_award_definition WHERE id=$1',
        [id],
      );
      if (!result.rows[0]) throw new NotFoundException('award not found');
      return result.rows[0].definition;
    } finally {
      client.release();
    }
  }

  async getAwardAsset(id: string): Promise<JsonRecord> {
    const client = await this.connect();
    try {
      const result = await client.query(
        'SELECT metadata FROM activity_asset WHERE id=$1',
        [id],
      );
      if (!result.rows[0]) throw new NotFoundException('award asset not found');
      return result.rows[0].metadata;
    } finally {
      client.release();
    }
  }

  async listAwardAssets(): Promise<JsonRecord[]> {
    const client = await this.connect();
    try {
      const result = await client.query(
        'SELECT metadata FROM activity_asset ORDER BY created_at',
      );
      return result.rows.map((row) => row.metadata);
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
          JSON.stringify(asset),
        ],
      );
      return asset;
    } finally {
      client.release();
    }
  }

  async createAwardRequest(record: JsonRecord): Promise<JsonRecord> {
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
          JSON.stringify(record.facts ?? {}),
          new Date(String(record.requestedAt)),
        ],
      );
      const saved = await client.query(
        'SELECT * FROM activity_award_request WHERE award_id=$1 AND level_id=$2 AND subject_id=$3',
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
          'awards-service',
        );
      return request;
    });
  }

  async listAwardRequests(subjectId?: string): Promise<JsonRecord[]> {
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT * FROM activity_award_request${subjectId ? ' WHERE subject_id=$1' : ''} ORDER BY requested_at DESC`,
        subjectId ? [subjectId] : [],
      );
      return result.rows.map(awardRequestRecord);
    } finally {
      client.release();
    }
  }

  async getAwardRequest(id: string): Promise<JsonRecord> {
    const client = await this.connect();
    try {
      const result = await client.query(
        'SELECT * FROM activity_award_request WHERE id=$1',
        [id],
      );
      if (!result.rows[0])
        throw new NotFoundException('award request not found');
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
        'SELECT * FROM activity_award_request WHERE id=$1 FOR UPDATE',
        [requestId],
      );
      if (!locked.rows[0])
        throw new NotFoundException('award request not found');
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
          JSON.stringify(issuance),
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
        'awards-service',
      );
      return issuance;
    });
  }

  async listAwardIssuances(): Promise<JsonRecord[]> {
    const client = await this.connect();
    try {
      const result = await client.query(
        'SELECT issuance FROM activity_award_issuance ORDER BY created_at DESC',
      );
      return result.rows.map((row) => row.issuance);
    } finally {
      client.release();
    }
  }

  async getAwardIssuance(id: string): Promise<JsonRecord> {
    const client = await this.connect();
    try {
      const result = await client.query(
        'SELECT issuance FROM activity_award_issuance WHERE id=$1',
        [id],
      );
      if (!result.rows[0])
        throw new NotFoundException('award issuance not found');
      return result.rows[0].issuance;
    } finally {
      client.release();
    }
  }

  async getAdifImport(id: string): Promise<JsonRecord> {
    const client = await this.connect();
    try {
      const result = await client.query(
        'SELECT * FROM activity_import WHERE id=$1',
        [id],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundException('ADIF import not found');
      return {
        id: String(row.id),
        activationId: String(row.activation_id),
        filename: row.filename,
        objectKey: row.object_key,
        bucket: row.bucket,
        sha256: row.sha256,
        contentSize: Number(row.content_size),
        malwareStatus: row.malware_status,
        status: row.status,
        recordsSeen: row.records_seen,
        recordsAccepted: row.records_accepted,
        recordsRejected: row.records_rejected,
        errors: row.errors,
        createdAt: date(row.created_at),
        startedAt: date(row.started_at),
        completedAt: date(row.completed_at),
      };
    } finally {
      client.release();
    }
  }

  async createAdifImport(
    activationId: string,
    metadata: JsonRecord,
    key?: string,
  ): Promise<JsonRecord> {
    return this.mutate(key ? `adif:${key}` : undefined, async (client) => {
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const record: JsonRecord = {
        id,
        activationId,
        ...metadata,
        status: 'QUEUED',
        malwareStatus: 'CLEAN',
        recordsSeen: 0,
        recordsAccepted: 0,
        recordsRejected: 0,
        errors: [],
        createdAt,
      };
      await client.query(
        `INSERT INTO activity_import
         (id,activation_id,filename,object_key,bucket,sha256,content_size,malware_status,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'CLEAN','QUEUED')`,
        [
          id,
          activationId,
          metadata.filename,
          metadata.objectKey,
          metadata.bucket,
          metadata.sha256,
          metadata.contentSize,
        ],
      );
      await this.job(client, 'ADIF_IMPORT', { importId: id }, `adif:${id}`);
      await this.event(
        client,
        'activity.adif.queued.v1',
        'adif_import',
        id,
        record,
      );
      return record;
    });
  }

  async subjectFacts(
    programme: string,
    subjectId: string,
    category: string,
  ): Promise<JsonRecord> {
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT qso_count,activation_count,unique_callsign_count,unique_entity_count,last_entity_type
         FROM activity_subject_aggregate WHERE programme_slug=$1 AND subject_id=$2 AND category=$3`,
        [programme, subjectId, category],
      );
      const row = result.rows[0];
      return row
        ? {
            qsoCount: Number(row.qso_count),
            activationCount: Number(row.activation_count),
            uniqueCallsignCount: Number(row.unique_callsign_count),
            uniqueEntityCount: Number(row.unique_entity_count),
            entityType: row.last_entity_type,
          }
        : {
            qsoCount: 0,
            activationCount: 0,
            uniqueCallsignCount: 0,
            uniqueEntityCount: 0,
            entityType: null,
          };
    } finally {
      client.release();
    }
  }

  async saveAwardProgress(
    award: JsonRecord,
    subjectId: string,
    facts: JsonRecord,
    evaluation: JsonRecord,
  ) {
    const client = await this.connect();
    try {
      await client.query(
        `INSERT INTO activity_award_progress(award_id,award_version,subject_id,category,facts,evaluation)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)
         ON CONFLICT (award_id,award_version,subject_id) DO UPDATE SET facts=EXCLUDED.facts,evaluation=EXCLUDED.evaluation,computed_at=now()`,
        [
          award.id,
          Number(award.version ?? 1),
          subjectId,
          award.category,
          JSON.stringify(facts),
          JSON.stringify(evaluation),
        ],
      );
    } finally {
      client.release();
    }
  }

  async listSubjectIds(
    programme: string,
    category?: string,
  ): Promise<string[]> {
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT DISTINCT subject_id FROM activity_subject_aggregate WHERE programme_slug=$1${category ? ' AND category=$2' : ''} ORDER BY subject_id`,
        category ? [programme, category] : [programme],
      );
      return result.rows.map((row) => String(row.subject_id));
    } finally {
      client.release();
    }
  }

  async createCorrection(
    qsoId: string,
    body: JsonRecord,
    key?: string,
  ): Promise<JsonRecord> {
    return this.mutate(key, async (client) => {
      const qso = await client.query(
        'SELECT id FROM activity_qso WHERE id=$1',
        [qsoId],
      );
      if (!qso.rows[0]) throw new NotFoundException('QSO not found');
      const result = await client.query(
        `INSERT INTO activity_qso_correction(id,qso_id,requested_by,reason,proposed_values)
         VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING *`,
        [
          randomUUID(),
          qsoId,
          body.requestedBy,
          body.reason,
          JSON.stringify(body.proposedValues),
        ],
      );
      return correctionRecord(result.rows[0]);
    });
  }

  async reviewCorrection(
    qsoId: string,
    correctionId: string,
    body: JsonRecord,
    key?: string,
  ): Promise<JsonRecord> {
    return this.mutate(key, async (client) => {
      const correctionResult = await client.query(
        'SELECT * FROM activity_qso_correction WHERE id=$1 FOR UPDATE',
        [correctionId],
      );
      const correction = correctionResult.rows[0];
      if (!correction || String(correction.qso_id) !== qsoId)
        throw new NotFoundException('QSO correction not found');
      if (correction.status !== 'PENDING')
        throw new BadRequestException('correction is no longer pending');
      const qsoResult = await client.query(
        'SELECT * FROM activity_qso WHERE id=$1 FOR UPDATE',
        [qsoId],
      );
      const qso = qsoResult.rows[0];
      if (!qso) throw new NotFoundException('QSO not found');
      if (body.decision === 'APPLIED') {
        const columns: Record<string, string> = {
          workedCallsign: 'worked_callsign',
          workedStationKey: 'worked_station_key',
          workedEntityId: 'worked_entity_id',
          occurredAt: 'occurred_at',
          band: 'band',
          mode: 'mode',
          rst: 'rst',
          hunterId: 'hunter_id',
          hunterCallsign: 'hunter_callsign',
        };
        const values = correction.proposed_values as JsonRecord;
        const assignments = ["status='CORRECTED'", 'corrected_at=now()'];
        const parameters: unknown[] = [];
        for (const [field, column] of Object.entries(columns)) {
          if (values[field] === undefined) continue;
          assignments.push(`${column}=$${parameters.length + 1}`);
          parameters.push(
            field === 'occurredAt' ? new Date(values[field]) : values[field],
          );
        }
        parameters.push(qsoId);
        await client.query(
          `UPDATE activity_qso SET ${assignments.join(',')} WHERE id=$${parameters.length}`,
          parameters,
        );
        await this.job(
          client,
          'AWARD_RECALCULATE',
          {
            programmeSlug: qso.programme_slug,
            subjectIds: [qso.operator_id, qso.hunter_id].filter(Boolean),
          },
          `correction:${correctionId}`,
        );
      }
      const result = await client.query(
        `UPDATE activity_qso_correction SET status=$1,reviewed_by=$2,review_note=$3,reviewed_at=now() WHERE id=$4 RETURNING *`,
        [body.decision, body.reviewedBy, body.reviewNote ?? null, correctionId],
      );
      return correctionRecord(result.rows[0]);
    });
  }

  async create(data: JsonRecord, key?: string): Promise<JsonRecord> {
    return this.mutate(key, async (client) => {
      const id = randomUUID();
      const validity =
        data.validityDays ?? data.programmeRules?.activationValidityDays;
      const validityDays =
        validity == null || ['', 'unlimited', 'UNLIMITED'].includes(validity)
          ? null
          : Number(validity);
      const inserted = await client.query(
        `INSERT INTO activity_activation
        (id,programme_slug,entity_id,entity_type,jurisdiction_code,operator_id,operator_callsign,started_at,validity_expires_at,location,programme_rules)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,
          CASE WHEN $9::double precision IS NULL THEN NULL
            ELSE $8::timestamptz + ($9 * interval '1 day') END,
          $10::jsonb,$11::jsonb)
        RETURNING *, ${activationTimestampProjection}`,
        [
          id,
          data.programmeSlug,
          data.entityId,
          data.entityType ?? null,
          data.jurisdiction ?? null,
          data.operatorId,
          data.operatorCallsign ?? null,
          data.startedAt,
          validityDays,
          JSON.stringify(data.location ?? {}),
          JSON.stringify(data.programmeRules ?? {}),
        ],
      );
      const record = activationRecord(inserted.rows[0], []);
      await this.event(
        client,
        'activity.activation.created.v1',
        'activation',
        id,
        record,
      );
      await this.upsertSubject(
        client,
        data.programmeSlug,
        data.operatorId,
        'ACTIVATOR',
        0,
        1,
        null,
        data.entityId,
        data.entityType,
      );
      return record;
    });
  }

  async addQso(
    activationId: string,
    qso: JsonRecord,
    key?: string,
  ): Promise<JsonRecord> {
    return this.mutate(key, async (client) => {
      const activationResult = await client.query(
        `SELECT *, $2::timestamptz < started_at AS qso_before_start,
          (validity_expires_at IS NOT NULL AND $2::timestamptz > validity_expires_at) AS qso_after_expiry
         FROM activity_activation WHERE id=$1 FOR UPDATE`,
        [activationId, qso.timestamp],
      );
      const activationRow = activationResult.rows[0];
      if (!activationRow) throw new NotFoundException('activation not found');
      if (activationRow.status !== 'OPEN')
        throw new BadRequestException('activation is not open');
      if (activationRow.qso_before_start || activationRow.qso_after_expiry)
        throw new BadRequestException(
          'QSO is outside the activation validity window',
        );
      const inserted = await client.query(
        `INSERT INTO activity_qso
        (id,activation_id,programme_slug,operator_id,operator_callsign,hunter_id,hunter_callsign,worked_callsign,worked_station_key,worked_entity_id,occurred_at,band,mode,rst,source,deduplication_key,raw_payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz,$12,$13,$14,$15,$16,$17::jsonb)
        ON CONFLICT (deduplication_key) DO NOTHING RETURNING *,
        ${qsoTimestampProjection}`,
        [
          qso.id,
          activationId,
          activationRow.programme_slug,
          activationRow.operator_id,
          activationRow.operator_callsign,
          qso.hunterId ?? null,
          qso.hunterCallsign ?? null,
          qso.workedCallsign,
          qso.workedStationKey,
          qso.workedEntityId ?? null,
          qso.timestamp,
          qso.band,
          qso.mode,
          qso.rst ?? null,
          qso.source,
          qso.deduplicationKey,
          JSON.stringify(qso),
        ],
      );
      const duplicate = inserted.rows.length === 0;
      const row = duplicate
        ? (
            await client.query(
              `SELECT *, ${qsoTimestampProjection}
               FROM activity_qso WHERE deduplication_key=$1`,
              [qso.deduplicationKey],
            )
          ).rows[0]
        : inserted.rows[0];
      if (!duplicate) {
        await this.upsertSubject(
          client,
          activationRow.programme_slug,
          activationRow.operator_id,
          'ACTIVATOR',
          1,
          0,
          qso.workedCallsign,
          activationRow.entity_id,
          activationRow.entity_type,
        );
        if (qso.hunterId)
          await this.upsertSubject(
            client,
            activationRow.programme_slug,
            qso.hunterId,
            'HUNTER',
            1,
            0,
            qso.workedCallsign,
            qso.workedEntityId,
            activationRow.entity_type,
          );
        await client.query(
          `UPDATE activity_activation SET qso_count=qso_count+1,
          unique_callsign_count=(SELECT count(DISTINCT worked_callsign) FROM activity_qso WHERE activation_id=$1 AND status<>'VOID'),
          unique_entity_count=(SELECT count(DISTINCT worked_entity_id) FROM activity_qso WHERE activation_id=$1 AND worked_entity_id IS NOT NULL AND status<>'VOID'),updated_at=now() WHERE id=$1`,
          [activationId],
        );
        await this.event(
          client,
          'activity.qso.recorded.v1',
          'qso',
          row.id,
          qsoRecord(row),
        );
        await this.job(
          client,
          'AWARD_RECALCULATE',
          {
            programmeSlug: activationRow.programme_slug,
            subjectIds: [activationRow.operator_id, qso.hunterId].filter(
              Boolean,
            ),
          },
          `qso:${row.id}`,
        );
      }
      const current = await client.query(
        'SELECT qso_count FROM activity_activation WHERE id=$1',
        [activationId],
      );
      return {
        activationId,
        qso: qsoRecord(row),
        qsoCount: current.rows[0].qso_count,
        duplicate,
      };
    });
  }

  async close(id: string, endedAt: string, key?: string): Promise<JsonRecord> {
    return this.mutate(key, async (client) => {
      const found = await client.query(
        `SELECT *, ${activationTimestampProjection} FROM activity_activation WHERE id=$1 FOR UPDATE`,
        [id],
      );
      if (!found.rows[0]) throw new NotFoundException('activation not found');
      if (found.rows[0].status !== 'OPEN')
        throw new BadRequestException('activation is not open');
      const qsos = await client.query(
        `SELECT *, ${qsoTimestampProjection}
         FROM activity_qso WHERE activation_id=$1 AND status<>'VOID' ORDER BY occurred_at`,
        [id],
      );
      const evaluation = evaluateActivation(
        activationRecord(found.rows[0]),
        qsos.rows.map(qsoRecord),
        endedAt,
      );
      const status = evaluation.valid ? 'CLOSED' : 'CLOSED_INVALID';
      const updated = await client.query(
        `UPDATE activity_activation SET status=$1,ended_at=$2::timestamptz,rule_evaluation=$3::jsonb,updated_at=now() WHERE id=$4 RETURNING *, ${activationTimestampProjection}`,
        [status, endedAt, JSON.stringify(evaluation), id],
      );
      const record = activationRecord(updated.rows[0], qsos.rows);
      await this.event(
        client,
        'activity.activation.closed.v1',
        'activation',
        id,
        record,
      );
      return record;
    });
  }

  async enqueueJob(
    kind: string,
    payload: JsonRecord,
    key?: string,
  ): Promise<JsonRecord> {
    return this.mutate(key, async (client) => {
      const id = randomUUID();
      const result = await client.query(
        'INSERT INTO activity_job(id,kind,payload,idempotency_key) VALUES ($1,$2,$3::jsonb,$4) RETURNING id,kind,payload,status,attempts,available_at,started_at,completed_at,last_error,created_at',
        [id, kind, JSON.stringify(payload), key ?? null],
      );
      await client.query(
        `INSERT INTO outbox_event(event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,available_at,correlation_id)
         VALUES ($1,$2,'activity-service','activity_job',$1,$3::jsonb,now(),now(),$4)`,
        [id, workEventType(kind), JSON.stringify({ jobId: id }), randomUUID()],
      );
      return jobRecord(result.rows[0]);
    });
  }

  async getJob(id: string): Promise<JsonRecord> {
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT id,kind,payload,status,attempts,available_at,started_at,completed_at,last_error,created_at,
         GREATEST(0,EXTRACT(EPOCH FROM (available_at-now()))) AS retry_after_seconds,
         GREATEST(0,EXTRACT(EPOCH FROM (lease_expires_at-now()))) AS lease_remaining_seconds
         FROM activity_job WHERE id=$1`,
        [id],
      );
      if (!result.rows[0])
        throw new NotFoundException('activity job not found');
      return {
        ...jobRecord(result.rows[0]),
        retryAfterSeconds: Number(result.rows[0].retry_after_seconds),
        leaseRemainingSeconds: Number(result.rows[0].lease_remaining_seconds),
      };
    } finally {
      client.release();
    }
  }

  async redriveFailedWorkJob(
    id: string,
    actor: string,
    reasonValue: unknown,
    key?: string,
  ): Promise<JsonRecord> {
    const reason = typeof reasonValue === 'string' ? reasonValue.trim() : '';
    if (!actor || actor.length > 120 || !reason || reason.length > 500)
      throw new BadRequestException(
        'actor and reason must be present and within the audit limits',
      );
    return this.mutate(key, async (client) => {
      const selected = await client.query(
        'SELECT id,kind,status,attempts FROM activity_job WHERE id=$1 FOR UPDATE',
        [id],
      );
      const job = selected.rows[0];
      if (!job) throw new NotFoundException('activity job not found');
      if (!['FAILED', 'QUEUED'].includes(job.status))
        throw new BadRequestException(
          'only failed or recoverable queued work may be redriven',
        );
      const registeredKinds = new Set([
        'QSO_INGESTION',
        'ADIF_IMPORT',
        'AWARD_EVALUATION',
        'AWARD_RECALCULATE',
        'PDF_RENDER',
        'STATISTICS_REBUILD',
      ]);
      if (!registeredKinds.has(job.kind))
        throw new BadRequestException(
          'job kind is not registered for Activity work delivery',
        );
      const outboxEventId = randomUUID();
      if (job.status === 'FAILED')
        await client.query(
          `UPDATE activity_job SET status='QUEUED',attempts=0,available_at=now(),
           started_at=NULL,completed_at=NULL,lease_expires_at=NULL,lease_token=NULL,last_error=NULL
           WHERE id=$1`,
          [id],
        );
      await client.query(
        `INSERT INTO outbox_event
         (event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,available_at)
         VALUES ($1,$2,'activity-service','activity_job',$3,$4::jsonb,now(),now())`,
        [
          outboxEventId,
          workEventType(job.kind),
          id,
          JSON.stringify({ jobId: id }),
        ],
      );
      await client.query(
        `INSERT INTO activity_work_redrive_audit(id,job_id,outbox_event_id,actor,reason)
         VALUES ($1,$2,$3,$4,$5)`,
        [randomUUID(), id, outboxEventId, actor, reason],
      );
      await client.query(
        'UPDATE activity_work_dead_letter SET resolved_at=now() WHERE work_id=$1 AND resolved_at IS NULL',
        [id],
      );
      return {
        jobId: id,
        status: 'QUEUED',
        redrivenBy: actor,
        reason,
        outboxEventId,
      };
    });
  }

  private async getWithClient(
    client: PoolClient,
    id: string,
  ): Promise<JsonRecord> {
    const result = await client.query(
      `SELECT *, ${activationTimestampProjection} FROM activity_activation WHERE id=$1`,
      [id],
    );
    if (!result.rows[0]) throw new NotFoundException('activation not found');
    const qsos = await client.query(
      `SELECT *, ${qsoTimestampProjection}
       FROM activity_qso WHERE activation_id=$1 AND status<>'VOID' ORDER BY occurred_at`,
      [id],
    );
    return activationRecord(result.rows[0], qsos.rows);
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
          'SELECT response FROM idempotency_record WHERE service=$1 AND key=$2',
          ['activity-service', key],
        );
        if (previous.rows[0]) {
          await client.query('COMMIT');
          return previous.rows[0].response as T;
        }
      }
      const result = await operation(client);
      if (key)
        await client.query(
          'INSERT INTO idempotency_record(service,key,response) VALUES ($1,$2,$3::jsonb)',
          ['activity-service', key, JSON.stringify(result)],
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
        JSON.stringify(payload),
        randomUUID(),
        producer,
      ],
    );
  }

  private async job(
    client: PoolClient,
    kind: string,
    payload: JsonRecord,
    key: string,
  ) {
    const id = randomUUID();
    const created = await client.query(
      `INSERT INTO activity_job(id,kind,payload,idempotency_key) VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [id, kind, JSON.stringify(payload), key],
    );
    if (created.rows[0])
      await client.query(
        `INSERT INTO outbox_event(event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,available_at,correlation_id) VALUES ($1,$3,'activity-service','activity_job',$1,$4::jsonb,now(),now(),$2) ON CONFLICT DO NOTHING`,
        [id, randomUUID(), workEventType(kind), JSON.stringify({ jobId: id })],
      );
  }

  private async rebuildSubjectAggregates(
    client: PoolClient,
    subjectIds: string[],
  ) {
    for (const subjectId of subjectIds) {
      await client.query(
        'DELETE FROM activity_subject_callsign WHERE subject_id=$1',
        [subjectId],
      );
      await client.query(
        'DELETE FROM activity_subject_entity WHERE subject_id=$1',
        [subjectId],
      );
      await client.query(
        'DELETE FROM activity_subject_aggregate WHERE subject_id=$1',
        [subjectId],
      );
      await client.query(
        `INSERT INTO activity_subject_aggregate
         (programme_slug,subject_id,category,qso_count,activation_count,unique_callsign_count,unique_entity_count,last_entity_type)
         SELECT a.programme_slug,a.operator_id,'ACTIVATOR',count(q.id),count(DISTINCT a.id),
          count(DISTINCT q.worked_callsign),count(DISTINCT a.entity_id),max(a.entity_type)
         FROM activity_activation a LEFT JOIN activity_qso q
          ON q.activation_id=a.id AND q.status<>'VOID'
         WHERE a.operator_id=$1 GROUP BY a.programme_slug,a.operator_id`,
        [subjectId],
      );
      await client.query(
        `INSERT INTO activity_subject_aggregate
         (programme_slug,subject_id,category,qso_count,activation_count,unique_callsign_count,unique_entity_count,last_entity_type)
         SELECT q.programme_slug,q.hunter_id,'HUNTER',count(*),0,
          count(DISTINCT q.worked_callsign),count(DISTINCT q.worked_entity_id),max(a.entity_type)
         FROM activity_qso q JOIN activity_activation a ON a.id=q.activation_id
         WHERE q.hunter_id=$1 AND q.status<>'VOID' GROUP BY q.programme_slug,q.hunter_id`,
        [subjectId],
      );
      await client.query(
        `INSERT INTO activity_subject_callsign(programme_slug,subject_id,category,callsign)
         SELECT DISTINCT a.programme_slug,a.operator_id,'ACTIVATOR',q.worked_callsign
          FROM activity_qso q JOIN activity_activation a ON a.id=q.activation_id
          WHERE a.operator_id=$1 AND q.status<>'VOID'
         UNION SELECT DISTINCT q.programme_slug,q.hunter_id,'HUNTER',q.worked_callsign
          FROM activity_qso q WHERE q.hunter_id=$2 AND q.status<>'VOID'`,
        [subjectId, subjectId],
      );
      await client.query(
        `INSERT INTO activity_subject_entity(programme_slug,subject_id,category,entity_id)
         SELECT DISTINCT a.programme_slug,a.operator_id,'ACTIVATOR',a.entity_id
          FROM activity_qso q JOIN activity_activation a ON a.id=q.activation_id
          WHERE a.operator_id=$1 AND q.status<>'VOID'
         UNION SELECT DISTINCT q.programme_slug,q.hunter_id,'HUNTER',q.worked_entity_id
          FROM activity_qso q WHERE q.hunter_id=$2 AND q.worked_entity_id IS NOT NULL AND q.status<>'VOID'`,
        [subjectId, subjectId],
      );
    }
  }

  private async upsertSubject(
    client: PoolClient,
    programme: string,
    subject: string,
    category: string,
    qsoDelta: number,
    activationDelta: number,
    callsign: string | null,
    entityId: string | null,
    entityType: string | null,
  ) {
    await client.query(
      `INSERT INTO activity_subject_aggregate(programme_slug,subject_id,category,qso_count,activation_count,last_entity_type)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (programme_slug,subject_id,category) DO UPDATE SET qso_count=activity_subject_aggregate.qso_count+EXCLUDED.qso_count,activation_count=activity_subject_aggregate.activation_count+EXCLUDED.activation_count,last_entity_type=COALESCE(EXCLUDED.last_entity_type,activity_subject_aggregate.last_entity_type),updated_at=now()`,
      [programme, subject, category, qsoDelta, activationDelta, entityType],
    );
    if (callsign)
      await client.query(
        'INSERT INTO activity_subject_callsign(programme_slug,subject_id,category,callsign) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [programme, subject, category, callsign],
      );
    if (entityId)
      await client.query(
        'INSERT INTO activity_subject_entity(programme_slug,subject_id,category,entity_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [programme, subject, category, entityId],
      );
    await client.query(
      `UPDATE activity_subject_aggregate a SET unique_callsign_count=(SELECT count(*) FROM activity_subject_callsign s WHERE s.programme_slug=a.programme_slug AND s.subject_id=a.subject_id AND s.category=a.category),unique_entity_count=(SELECT count(*) FROM activity_subject_entity e WHERE e.programme_slug=a.programme_slug AND e.subject_id=a.subject_id AND e.category=a.category),updated_at=now() WHERE a.programme_slug=$1 AND a.subject_id=$2 AND a.category=$3`,
      [programme, subject, category],
    );
  }

  private async connect() {
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
}

function activationRecord(row: any, qsos?: any[]) {
  const record = {
    id: String(row.id),
    programmeSlug: row.programme_slug,
    entityId: row.entity_id,
    entityType: row.entity_type,
    jurisdiction: row.jurisdiction_code,
    operatorId: row.operator_id,
    operatorCallsign: row.operator_callsign,
    startedAt: row.started_at_iso ?? date(row.started_at),
    endedAt: row.ended_at_iso ?? date(row.ended_at),
    validityExpiresAt:
      row.validity_expires_at_iso ?? date(row.validity_expires_at),
    status: row.status,
    location: row.location ?? {},
    programmeRules: row.programme_rules ?? {},
    ruleEvaluation: row.rule_evaluation ?? {},
    qsoCount: row.qso_count,
    uniqueCallsignCount: row.unique_callsign_count,
    uniqueEntityCount: row.unique_entity_count,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
  return qsos ? { ...record, qsos: qsos.map(qsoRecord) } : record;
}

function qsoRecord(row: any) {
  return {
    id: String(row.id),
    activationId: String(row.activation_id),
    programmeSlug: row.programme_slug,
    operatorId: row.operator_id,
    operatorCallsign: row.operator_callsign,
    hunterId: row.hunter_id,
    hunterCallsign: row.hunter_callsign,
    workedCallsign: row.worked_callsign,
    workedStationKey: row.worked_station_key,
    workedEntityId: row.worked_entity_id,
    timestamp: normalizeTimestamp(row.occurred_at_iso ?? row.occurred_at),
    band: row.band,
    mode: row.mode,
    rst: row.rst,
    source: row.source,
    status: row.status,
    deduplicationKey: row.deduplication_key,
    createdAt: date(row.created_at),
  };
}

function date(value: unknown) {
  return value == null
    ? null
    : new Date(value as string | number | Date).toISOString();
}

function workEventType(kind: string) {
  const byKind: Record<string, string> = {
    AWARD_RECALCULATE: 'activity.award-recalculate.v1',
    QSO_INGESTION: 'activity.qso-ingestion.v1',
  };
  return (
    byKind[kind] ?? `activity.${kind.toLowerCase().replaceAll('_', '-')}.v1`
  );
}

function jobRecord(row: any) {
  return {
    id: String(row.id),
    kind: row.kind,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    availableAt: date(row.available_at),
    startedAt: date(row.started_at),
    completedAt: date(row.completed_at),
    lastError: row.last_error,
    createdAt: date(row.created_at),
  };
}

function correctionRecord(row: any) {
  return {
    id: String(row.id),
    qsoId: String(row.qso_id),
    requestedBy: row.requested_by,
    reason: row.reason,
    proposedValues: row.proposed_values,
    status: row.status,
    reviewedBy: row.reviewed_by,
    reviewNote: row.review_note,
    createdAt: date(row.created_at),
    reviewedAt: date(row.reviewed_at),
  };
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
    facts: row.facts,
    status: row.status,
    issuedAwardId: row.issued_award_id ? String(row.issued_award_id) : null,
    requestedAt: date(row.requested_at),
    issuedAt: date(row.issued_at),
  };
}
