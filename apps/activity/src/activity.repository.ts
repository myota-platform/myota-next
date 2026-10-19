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
import { evaluateActivation, type JsonRecord } from './activity-domain.js';

@Injectable()
export class ActivityRepository {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async list(programme?: string, operatorId?: string) {
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT * FROM activity_activation${programme || operatorId ? ' WHERE ' : ''}${programme ? 'programme_slug=$1' : ''}${programme && operatorId ? ' AND ' : ''}${operatorId ? `operator_id=$${programme ? 2 : 1}` : ''} ORDER BY started_at DESC`,
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

  async get(id: string): Promise<JsonRecord> {
    const client = await this.connect();
    try {
      return await this.getWithClient(client, id);
    } finally {
      client.release();
    }
  }

  async getQso(id: string): Promise<JsonRecord> {
    const client = await this.connect();
    try {
      const result = await client.query(
        'SELECT * FROM activity_qso WHERE id=$1',
        [id],
      );
      if (!result.rows[0]) throw new NotFoundException('QSO not found');
      return qsoRecord(result.rows[0]);
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
      const started = new Date(data.startedAt);
      const validity =
        data.validityDays ?? data.programmeRules?.activationValidityDays;
      const expires =
        validity == null || ['', 'unlimited', 'UNLIMITED'].includes(validity)
          ? null
          : new Date(started.getTime() + Number(validity) * 86400000);
      const inserted = await client.query(
        `INSERT INTO activity_activation
        (id,programme_slug,entity_id,entity_type,jurisdiction_code,operator_id,operator_callsign,started_at,validity_expires_at,location,programme_rules)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb) RETURNING *`,
        [
          id,
          data.programmeSlug,
          data.entityId,
          data.entityType ?? null,
          data.jurisdiction ?? null,
          data.operatorId,
          data.operatorCallsign ?? null,
          started,
          expires,
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
        'SELECT * FROM activity_activation WHERE id=$1 FOR UPDATE',
        [activationId],
      );
      const activationRow = activationResult.rows[0];
      if (!activationRow) throw new NotFoundException('activation not found');
      if (activationRow.status !== 'OPEN')
        throw new BadRequestException('activation is not open');
      const occurredAt = new Date(qso.timestamp);
      if (
        occurredAt < new Date(activationRow.started_at) ||
        (activationRow.validity_expires_at &&
          occurredAt > new Date(activationRow.validity_expires_at))
      )
        throw new BadRequestException(
          'QSO is outside the activation validity window',
        );
      const inserted = await client.query(
        `INSERT INTO activity_qso
        (id,activation_id,programme_slug,operator_id,operator_callsign,hunter_id,hunter_callsign,worked_callsign,worked_station_key,worked_entity_id,occurred_at,band,mode,rst,source,deduplication_key,raw_payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
        ON CONFLICT (deduplication_key) DO NOTHING RETURNING *`,
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
          occurredAt,
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
              'SELECT * FROM activity_qso WHERE deduplication_key=$1',
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
        'SELECT * FROM activity_activation WHERE id=$1 FOR UPDATE',
        [id],
      );
      if (!found.rows[0]) throw new NotFoundException('activation not found');
      if (found.rows[0].status !== 'OPEN')
        throw new BadRequestException('activation is not open');
      const qsos = await client.query(
        "SELECT * FROM activity_qso WHERE activation_id=$1 AND status<>'VOID' ORDER BY occurred_at",
        [id],
      );
      const evaluation = evaluateActivation(
        activationRecord(found.rows[0]),
        qsos.rows.map(qsoRecord),
        endedAt,
      );
      const status = evaluation.valid ? 'CLOSED' : 'CLOSED_INVALID';
      const updated = await client.query(
        'UPDATE activity_activation SET status=$1,ended_at=$2,rule_evaluation=$3::jsonb,updated_at=now() WHERE id=$4 RETURNING *',
        [status, new Date(endedAt), JSON.stringify(evaluation), id],
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

  private async getWithClient(
    client: PoolClient,
    id: string,
  ): Promise<JsonRecord> {
    const result = await client.query(
      'SELECT * FROM activity_activation WHERE id=$1',
      [id],
    );
    if (!result.rows[0]) throw new NotFoundException('activation not found');
    const qsos = await client.query(
      "SELECT * FROM activity_qso WHERE activation_id=$1 AND status<>'VOID' ORDER BY occurred_at",
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
  ) {
    await client.query(
      `INSERT INTO outbox_event(event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
      VALUES ($1,$2,'activity-service',$3,$4,$5::jsonb,now(),$6)`,
      [
        randomUUID(),
        type,
        aggregate,
        id,
        JSON.stringify(payload),
        randomUUID(),
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
    startedAt: date(row.started_at),
    endedAt: date(row.ended_at),
    validityExpiresAt: date(row.validity_expires_at),
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
    timestamp: date(row.occurred_at),
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
