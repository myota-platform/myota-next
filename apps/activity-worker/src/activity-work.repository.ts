import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import {
  normalizeQso,
  type JsonRecord,
} from '../../activity/src/activity-domain.js';

interface ClaimedJob {
  id: string;
  kind: string;
  payload: JsonRecord;
  attempts: number;
  leaseToken: string;
}

@Injectable()
export class ActivityWorkRepository {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async claim(): Promise<ClaimedJob | null> {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        `SELECT id FROM activity_job WHERE kind='QSO_INGESTION' AND available_at<=now()
         AND (status='QUEUED' OR (status='RUNNING' AND lease_expires_at<now()))
         ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      if (!selected.rows[0]) {
        await client.query('COMMIT');
        return null;
      }
      const leaseToken = randomUUID();
      const updated = await client.query(
        `UPDATE activity_job SET status='RUNNING',attempts=attempts+1,
         started_at=COALESCE(started_at,now()),lease_expires_at=now()+interval '120 seconds',lease_token=$2
         WHERE id=$1 RETURNING id,kind,payload,attempts,lease_token`,
        [selected.rows[0].id, leaseToken],
      );
      await client.query('COMMIT');
      const row = updated.rows[0];
      return {
        id: String(row.id),
        kind: row.kind,
        payload: row.payload,
        attempts: row.attempts,
        leaseToken: String(row.lease_token),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async process(job: ClaimedJob) {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const lease = await client.query(
        `SELECT id FROM activity_job WHERE id=$1 AND status='RUNNING' AND lease_token=$2 FOR UPDATE`,
        [job.id, job.leaseToken],
      );
      if (!lease.rows[0])
        throw new Error('worker lease was lost before processing');
      const activationResult = await client.query(
        'SELECT * FROM activity_activation WHERE id=$1 FOR UPDATE',
        [job.payload.activationId],
      );
      const activation = activationResult.rows[0];
      if (!activation) throw new Error('activation not found');
      if (activation.status !== 'OPEN')
        throw new Error('activation is not open');
      const records = job.payload.records;
      if (!Array.isArray(records) || records.length === 0)
        throw new Error('ingestion records are empty');
      let accepted = 0;
      for (const input of records) {
        const qso = normalizeQso(
          { ...input, source: job.payload.sourceFormat ?? 'JSON' },
          job.payload.activationId,
        );
        const occurred = new Date(qso.timestamp);
        if (
          occurred < new Date(activation.started_at) ||
          (activation.validity_expires_at &&
            occurred > new Date(activation.validity_expires_at))
        )
          throw new Error('QSO is outside the activation validity window');
        const id = randomUUID();
        const inserted = await client.query(
          `INSERT INTO activity_qso(id,activation_id,programme_slug,operator_id,operator_callsign,hunter_id,hunter_callsign,worked_callsign,worked_station_key,worked_entity_id,occurred_at,band,mode,rst,source,deduplication_key,raw_payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
           ON CONFLICT (deduplication_key) DO NOTHING RETURNING *`,
          [
            id,
            job.payload.activationId,
            activation.programme_slug,
            activation.operator_id,
            activation.operator_callsign,
            qso.hunterId ?? null,
            qso.hunterCallsign ?? null,
            qso.workedCallsign,
            qso.workedStationKey,
            qso.workedEntityId ?? null,
            occurred,
            qso.band,
            qso.mode,
            qso.rst ?? null,
            qso.source,
            qso.deduplicationKey,
            JSON.stringify(qso),
          ],
        );
        const row = inserted.rows[0];
        if (!row) continue;
        accepted++;
        await upsertSubject(
          client,
          activation.programme_slug,
          activation.operator_id,
          'ACTIVATOR',
          qso.workedCallsign,
          activation.entity_id,
          activation.entity_type,
        );
        if (qso.hunterId)
          await upsertSubject(
            client,
            activation.programme_slug,
            qso.hunterId,
            'HUNTER',
            qso.workedCallsign,
            qso.workedEntityId ?? null,
            activation.entity_type,
          );
        await client.query(
          `INSERT INTO outbox_event(event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
           VALUES ($1,'activity.qso.recorded.v1','activity-service','qso',$2,$3::jsonb,now(),$4)`,
          [
            randomUUID(),
            String(row.id),
            JSON.stringify(qsoRecord(row)),
            randomUUID(),
          ],
        );
      }
      if (accepted) {
        await client.query(
          `UPDATE activity_activation SET qso_count=qso_count+$2,
           unique_callsign_count=(SELECT count(DISTINCT worked_callsign) FROM activity_qso WHERE activation_id=$1 AND status<>'VOID'),
           unique_entity_count=(SELECT count(DISTINCT worked_entity_id) FROM activity_qso WHERE activation_id=$1 AND worked_entity_id IS NOT NULL AND status<>'VOID'),updated_at=now() WHERE id=$1`,
          [job.payload.activationId, accepted],
        );
        const awardJobId = randomUUID();
        const subjectIds = [
          ...new Set([
            activation.operator_id,
            ...records.map((qso: JsonRecord) => qso.hunterId).filter(Boolean),
          ]),
        ];
        await client.query(
          `INSERT INTO activity_job(id,kind,payload,idempotency_key) VALUES ($1,'AWARD_RECALCULATE',$2::jsonb,$3) ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            awardJobId,
            JSON.stringify({
              programmeSlug: activation.programme_slug,
              subjectIds,
            }),
            `ingestion:${job.id}`,
          ],
        );
        await client.query(
          `INSERT INTO outbox_event(event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,available_at,correlation_id)
           SELECT id,'activity.award-recalculate.v1','activity-service','activity_job',id,jsonb_build_object('jobId',id),now(),now(),$2 FROM activity_job WHERE idempotency_key=$1 ON CONFLICT DO NOTHING`,
          [`ingestion:${job.id}`, randomUUID()],
        );
      }
      const completed = await client.query(
        `UPDATE activity_job SET status='SUCCEEDED',completed_at=now(),lease_expires_at=NULL,lease_token=NULL,last_error=NULL
         WHERE id=$1 AND status='RUNNING' AND lease_token=$2 RETURNING id`,
        [job.id, job.leaseToken],
      );
      if (!completed.rows[0])
        throw new Error('worker lease was lost before completion');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async retry(job: ClaimedJob, error: unknown) {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const message =
        error instanceof Error ? error.name.slice(0, 80) : 'worker error';
      if (job.attempts >= 8) {
        const failed = await client.query(
          `UPDATE activity_job SET status='FAILED',completed_at=now(),lease_expires_at=NULL,lease_token=NULL,last_error=$3 WHERE id=$1 AND lease_token=$2`,
          [job.id, job.leaseToken, message],
        );
        if (!failed.rowCount)
          throw new Error('worker lease was lost before dead-lettering');
        await client.query(
          `INSERT INTO activity_work_dead_letter(id,work_id,work_type,subject,delivery_count,error_category) VALUES ($1,$2,'activity.qso-ingestion.v1',$3,$4,$5)`,
          [
            randomUUID(),
            job.id,
            `myota.work.activity.qso-ingestion.v1:${job.id}`,
            job.attempts,
            message,
          ],
        );
      } else {
        const delay = Math.min(300, 2 ** Math.min(job.attempts, 8));
        const retried = await client.query(
          `UPDATE activity_job SET status='QUEUED',available_at=now()+make_interval(secs=>$3),lease_expires_at=NULL,lease_token=NULL,last_error=$4 WHERE id=$1 AND lease_token=$2`,
          [job.id, job.leaseToken, delay, message],
        );
        if (!retried.rowCount)
          throw new Error('worker lease was lost before retry');
      }
      await client.query('COMMIT');
    } catch (failure) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw failure;
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
}

async function upsertSubject(
  client: PoolClient,
  programme: string,
  subject: string,
  category: string,
  callsign: string,
  entityId: string | null,
  entityType: string | null,
) {
  await client.query(
    `INSERT INTO activity_subject_aggregate(programme_slug,subject_id,category,qso_count,last_entity_type) VALUES ($1,$2,$3,1,$4)
    ON CONFLICT (programme_slug,subject_id,category) DO UPDATE SET qso_count=activity_subject_aggregate.qso_count+1,last_entity_type=COALESCE(EXCLUDED.last_entity_type,activity_subject_aggregate.last_entity_type),updated_at=now()`,
    [programme, subject, category, entityType],
  );
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
    timestamp: new Date(row.occurred_at).toISOString(),
    band: row.band,
    mode: row.mode,
    rst: row.rst,
    source: row.source,
    status: row.status,
    deduplicationKey: row.deduplication_key,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
