import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import { MAX_UPLOAD_BYTES } from '@app/platform/import-limits.js';
import { parsePageTotal } from '@app/platform/pagination.js';
import { renderCertificatePdf } from '@app/platform/certificate-renderer.js';
import { pythonString } from '@app/platform/python-strings.js';
import { pythonTruthy } from '@app/platform/python-truthiness.js';
import {
  compareTimestamps,
  adifAwardRecalculationKey,
  calculateAdifRejectedRecords,
  normalizeTimestamp,
  parseAdif,
  normalizeQso,
  pythonInt,
  type JsonRecord,
} from '../../activity/src/activity-domain.js';
import { evaluateAward } from '../../activity/src/award-domain.js';

const qsoTimestampProjection = `to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at_iso`;

export interface ClaimedJob {
  id: string;
  kind: string;
  payload: JsonRecord;
  attempts: number;
  leaseToken: string;
}

export interface WorkJobState {
  id: string;
  kind: string;
  status: string;
  retryAfterSeconds: number;
  leaseRemainingSeconds: number;
}

const WORK_TYPE_BY_KIND: Record<string, string> = {
  QSO_INGESTION: 'activity.qso-ingestion.v1',
  ADIF_IMPORT: 'activity.adif-import.v1',
  AWARD_RECALCULATE: 'activity.award-recalculate.v1',
  AWARD_EVALUATION: 'activity.award-evaluation.v1',
  PDF_RENDER: 'activity.pdf-render.v1',
  STATISTICS_REBUILD: 'activity.statistics-rebuild.v1',
};

@Injectable()
export class ActivityWorkRepository {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async claimWorkJob(
    id: string,
    expectedKind: string,
    leaseSeconds = 120,
  ): Promise<ClaimedJob | null> {
    const client = await this.connect();
    try {
      const leaseToken = randomUUID();
      const updated = await client.query(
        `UPDATE activity_job SET status='RUNNING',attempts=attempts+1,
         started_at=COALESCE(started_at,now()),lease_expires_at=now()+make_interval(secs=>$3),lease_token=$4
         WHERE id=$1 AND kind=$2 AND available_at<=now()
           AND (status='QUEUED' OR (status='RUNNING' AND lease_expires_at<now()))
         RETURNING id,kind,payload,attempts,lease_token`,
        [id, expectedKind, leaseSeconds, leaseToken],
      );
      const row = updated.rows[0];
      if (!row) return null;
      return {
        id: String(row.id),
        kind: row.kind,
        payload: row.payload,
        attempts: row.attempts,
        leaseToken: String(row.lease_token),
      };
    } finally {
      client.release();
    }
  }

  async getWorkJobState(id: string): Promise<WorkJobState | null> {
    const client = await this.connect();
    try {
      const result = await client.query<WorkJobState>(
        `SELECT id,kind,status,
          GREATEST(0,EXTRACT(EPOCH FROM (available_at-now()))) AS "retryAfterSeconds",
          GREATEST(0,EXTRACT(EPOCH FROM (lease_expires_at-now()))) AS "leaseRemainingSeconds"
         FROM activity_job WHERE id=$1`,
        [id],
      );
      const row = result.rows[0];
      return row
        ? {
            ...row,
            retryAfterSeconds: Number(row.retryAfterSeconds ?? 0),
            leaseRemainingSeconds: Number(row.leaseRemainingSeconds ?? 0),
          }
        : null;
    } finally {
      client.release();
    }
  }

  async reconcileQueuedWorkOutbox(limit = 100): Promise<number> {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const jobs = await client.query(
        `SELECT id,kind,created_at,available_at FROM activity_job
         WHERE status='QUEUED' AND kind=ANY($1::text[])
         ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT $2`,
        [Object.keys(WORK_TYPE_BY_KIND), limit],
      );
      let repaired = 0;
      for (const job of jobs.rows) {
        const inserted = await client.query(
          `INSERT INTO outbox_event(event_id,event_type,producer,aggregate_type,aggregate_id,
             payload,occurred_at,available_at)
           VALUES ($1,$2,'activity-service','activity_job',$1,$3::jsonb,$4,$5)
           ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
          [
            job.id,
            WORK_TYPE_BY_KIND[job.kind],
            JSON.stringify({ jobId: String(job.id) }),
            job.created_at,
            job.available_at,
          ],
        );
        repaired += inserted.rowCount ?? 0;
      }
      await client.query('COMMIT');
      return repaired;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordWorkDeadLetter(
    subject: string,
    workId: string | null,
    workType: string | null,
    deliveryCount: number,
    errorCategory: string,
  ): Promise<void> {
    const client = await this.connect();
    try {
      await client.query(
        `INSERT INTO activity_work_dead_letter
          (id,work_id,work_type,subject,delivery_count,error_category)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          randomUUID(),
          workId,
          workType,
          subject.slice(0, 255),
          Math.max(1, deliveryCount),
          errorCategory.slice(0, 80),
        ],
      );
    } finally {
      client.release();
    }
  }

  async heartbeat(job: ClaimedJob): Promise<boolean> {
    const client = await this.connect();
    try {
      const result = await client.query(
        `UPDATE activity_job SET lease_expires_at=now()+interval '120 seconds'
         WHERE id=$1 AND status='RUNNING' AND lease_token=$2 RETURNING id`,
        [job.id, job.leaseToken],
      );
      return Boolean(result.rows[0]);
    } finally {
      client.release();
    }
  }

  async process(job: ClaimedJob) {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const lease = await client.query(
        `SELECT id FROM activity_job WHERE id=$1 AND status='RUNNING' AND lease_token=$2`,
        [job.id, job.leaseToken],
      );
      if (!lease.rows[0])
        throw new Error('worker lease was lost before processing');
      if (job.kind === 'ADIF_IMPORT') {
        await client.query(
          "UPDATE activity_import SET status='PROCESSING',started_at=now() WHERE id=$1 AND status='QUEUED'",
          [job.payload.importId],
        );
        await client.query('COMMIT');
        await client.query('BEGIN');
        const currentLease = await client.query(
          `SELECT id FROM activity_job WHERE id=$1 AND status='RUNNING' AND lease_token=$2`,
          [job.id, job.leaseToken],
        );
        if (!currentLease.rows[0])
          throw new Error('worker lease was lost before processing');
        await this.processAdifImport(client, job.payload);
      } else if (job.kind === 'QSO_INGESTION') {
        const activationResult = await client.query(
          `SELECT *,
            to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at_iso,
            to_char(validity_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS validity_expires_at_iso
           FROM activity_activation WHERE id=$1 FOR UPDATE`,
          [job.payload.activationId],
        );
        const activation = activationResult.rows[0];
        if (!activation) throw new Error('activation not found');
        if (activation.status !== 'OPEN')
          throw new Error('activation is not open');
        const records = job.payload.records;
        if (!Array.isArray(records) || records.length === 0)
          throw new Error('ingestion records are empty');
        const normalized: JsonRecord[] = [];
        for (const input of records) {
          const qso = normalizeQso(
            {
              ...input,
              source: Object.hasOwn(job.payload, 'sourceFormat')
                ? job.payload.sourceFormat
                : 'JSON',
            },
            job.payload.activationId,
          );
          if (
            compareTimestamps(qso.timestamp, activation.started_at_iso) < 0 ||
            (activation.validity_expires_at_iso &&
              compareTimestamps(
                qso.timestamp,
                activation.validity_expires_at_iso,
              ) > 0)
          )
            throw new Error('QSO is outside the activation validity window');
          normalized.push(qso);
        }
        const inserted = await client.query(
          `INSERT INTO activity_qso
           (id,activation_id,programme_slug,operator_id,operator_callsign,hunter_id,hunter_callsign,
            worked_callsign,worked_station_key,worked_entity_id,occurred_at,band,mode,rst,source,
            source_import_id,deduplication_key,raw_payload)
           SELECT qso.id,$2,$3,$4,$5::public.citext,qso.hunter_id::text,
             qso.hunter_callsign::public.citext,qso.worked_callsign::public.citext,
             qso.worked_station_key,qso.worked_entity_id,qso.occurred_at,qso.band,qso.mode,
             qso.rst,qso.source,qso.source_import_id,qso.deduplication_key,qso.raw_payload
           FROM jsonb_to_recordset($1::jsonb) AS qso(
             id uuid,hunter_id text,hunter_callsign text,worked_callsign text,
             worked_station_key text,worked_entity_id text,occurred_at timestamptz,
             band text,mode text,rst text,source text,source_import_id uuid,
             deduplication_key text,raw_payload jsonb
           )
           ON CONFLICT (deduplication_key) DO NOTHING
           RETURNING *, ${qsoTimestampProjection}`,
          [
            JSON.stringify(
              normalized.map((qso) => ({
                id: qso.id,
                hunter_id: qso.hunterId ?? null,
                hunter_callsign: qso.hunterCallsign ?? null,
                worked_callsign: qso.workedCallsign,
                worked_station_key: qso.workedStationKey,
                worked_entity_id: qso.workedEntityId ?? null,
                occurred_at: qso.timestamp,
                band: qso.band,
                mode: qso.mode,
                rst: qso.rst ?? null,
                source: qso.source,
                source_import_id: qso.sourceImportId ?? null,
                deduplication_key: qso.deduplicationKey,
                raw_payload: qso,
              })),
            ),
            job.payload.activationId,
            activation.programme_slug,
            activation.operator_id,
            activation.operator_callsign,
          ],
        );
        const acceptedRows = inserted.rows;
        for (const row of acceptedRows) {
          const qso = qsoRecord(row);
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
            [randomUUID(), String(row.id), JSON.stringify(qso), randomUUID()],
          );
        }
        const accepted = acceptedRows.length;
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
              ...records
                .map((qso: JsonRecord) => qso.hunterId)
                .filter(pythonTruthy),
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
              `batch:${job.payload.activationId}:${normalized[0].deduplicationKey}`,
            ],
          );
          await client.query(
            `INSERT INTO outbox_event(event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,available_at,correlation_id)
           SELECT id,'activity.award-recalculate.v1','activity-service','activity_job',id,jsonb_build_object('jobId',id),now(),now(),$2 FROM activity_job WHERE idempotency_key=$1 ON CONFLICT DO NOTHING`,
            [
              `batch:${job.payload.activationId}:${normalized[0].deduplicationKey}`,
              randomUUID(),
            ],
          );
        }
      } else if (job.kind === 'AWARD_EVALUATION') {
        await this.processAwardEvaluation(client, job.payload);
      } else if (job.kind === 'AWARD_RECALCULATE') {
        await this.processAwardRecalculation(client, job.payload);
      } else if (job.kind === 'PDF_RENDER') {
        await this.processPdfRender(client, job.payload);
      } else if (job.kind === 'STATISTICS_REBUILD') {
        await this.processStatisticsRebuild(client, job.payload);
      } else {
        throw new Error(`unsupported Activity job kind: ${job.kind}`);
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

  private async processAdifImport(client: PoolClient, payload: JsonRecord) {
    const importId = String(payload.importId ?? '');
    if (!importId) throw new Error('ADIF import id is required');
    const selected = await client.query(
      `SELECT i.*,a.programme_slug,a.operator_id,a.operator_callsign,a.entity_id,
        a.entity_type,a.status AS activation_status,a.started_at,a.validity_expires_at,
        to_char(a.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS activation_started_at_iso,
        to_char(a.validity_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS activation_validity_expires_at_iso
       FROM activity_import i JOIN activity_activation a ON a.id=i.activation_id
       WHERE i.id=$1 FOR UPDATE OF i,a`,
      [importId],
    );
    const record = selected.rows[0];
    if (!record) throw new Error('ADIF import not found');
    if (['COMPLETED', 'FAILED'].includes(record.status)) return;
    let content: Buffer;
    try {
      content = await readObject(
        objectStoreClient(),
        record.bucket,
        record.object_key,
      );
    } catch {
      await this.finishAdifImport(
        client,
        record,
        0,
        0,
        1,
        ['uploaded object is not available'],
        'FAILED',
      );
      return;
    }
    let rows: JsonRecord[];
    try {
      await scanAdifContent(content, record.filename);
      rows = parseAdif(
        new TextDecoder('utf-8', { fatal: true }).decode(content),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.finishAdifImport(client, record, 0, 0, 1, [message], 'FAILED');
      return;
    }
    let accepted = 0;
    let normalizationErrorCount = 0;
    const errors: string[] = [];
    const awardSubjects = new Set<string>([String(record.operator_id)]);
    const normalized: { index: number; qso: JsonRecord }[] = [];
    for (let index = 0; index < rows.length; index++) {
      try {
        const qso = normalizeQso(
          { ...rows[index], source: 'adif', sourceImportId: importId },
          String(record.activation_id),
        );
        if (qso.hunterId) awardSubjects.add(String(qso.hunterId));
        normalized.push({ index, qso });
      } catch (error) {
        normalizationErrorCount++;
        errors.push(
          `record ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (normalized.length && record.activation_status !== 'OPEN')
      throw new Error('activation is not open');
    if (
      normalized.some(
        ({ qso }) =>
          compareTimestamps(qso.timestamp, record.activation_started_at_iso) <
            0 ||
          (record.activation_validity_expires_at_iso &&
            compareTimestamps(
              qso.timestamp,
              record.activation_validity_expires_at_iso,
            ) > 0),
      )
    ) {
      throw new Error('a QSO is outside the activation validity window');
    }
    const recordNumbers = new Map<string, number>();
    for (const item of normalized)
      if (!recordNumbers.has(item.qso.deduplicationKey))
        recordNumbers.set(item.qso.deduplicationKey, item.index + 1);
    const insertedRows: JsonRecord[] = [];
    if (normalized.length) {
      await client.query('SAVEPOINT adif_batch_insert');
      try {
        const inserted = await client.query(
          `INSERT INTO activity_qso
           (id,activation_id,programme_slug,operator_id,operator_callsign,hunter_id,hunter_callsign,
            worked_callsign,worked_station_key,worked_entity_id,occurred_at,band,mode,rst,source,
            source_import_id,deduplication_key,raw_payload)
           SELECT qso.id,$2,$3,$4,$5::public.citext,qso.hunter_id::text,
             qso.hunter_callsign::public.citext,qso.worked_callsign::public.citext,
             qso.worked_station_key,qso.worked_entity_id,qso.occurred_at,qso.band,qso.mode,
             qso.rst,qso.source,qso.source_import_id,qso.deduplication_key,qso.raw_payload
           FROM jsonb_to_recordset($1::jsonb) AS qso(
             id uuid,hunter_id text,hunter_callsign text,worked_callsign text,
             worked_station_key text,worked_entity_id text,occurred_at timestamptz,
             band text,mode text,rst text,source text,source_import_id uuid,
             deduplication_key text,raw_payload jsonb
           )
           ON CONFLICT (deduplication_key) DO NOTHING
           RETURNING *, ${qsoTimestampProjection}`,
          [
            JSON.stringify(
              normalized.map(({ qso }) => ({
                id: qso.id,
                hunter_id: qso.hunterId ?? null,
                hunter_callsign: qso.hunterCallsign ?? null,
                worked_callsign: qso.workedCallsign,
                worked_station_key: qso.workedStationKey,
                worked_entity_id: qso.workedEntityId ?? null,
                occurred_at: qso.timestamp,
                band: qso.band,
                mode: qso.mode,
                rst: qso.rst ?? null,
                source: qso.source,
                source_import_id: qso.sourceImportId ?? null,
                deduplication_key: qso.deduplicationKey,
                raw_payload: qso,
              })),
            ),
            record.activation_id,
            record.programme_slug,
            record.operator_id,
            record.operator_callsign,
          ],
        );
        await client.query('RELEASE SAVEPOINT adif_batch_insert');
        insertedRows.push(...inserted.rows);
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT adif_batch_insert');
        await client.query('RELEASE SAVEPOINT adif_batch_insert');
        for (const { index, qso } of normalized) {
          const savepoint = `adif_insert_${index}`;
          await client.query(`SAVEPOINT ${savepoint}`);
          try {
            const row = await this.insertAdifQso(client, record, importId, qso);
            if (row) insertedRows.push(row);
            await client.query(`RELEASE SAVEPOINT ${savepoint}`);
          } catch (error) {
            await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            await client.query(`RELEASE SAVEPOINT ${savepoint}`);
            errors.push(
              `record ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    }
    for (const row of insertedRows) {
      const recordNumber =
        recordNumbers.get(String(row.deduplication_key)) ?? 1;
      const savepoint = `adif_effect_${recordNumber}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        const qso = qsoRecord(row);
        await upsertSubject(
          client,
          record.programme_slug,
          record.operator_id,
          'ACTIVATOR',
          qso.workedCallsign,
          record.entity_id,
          record.entity_type,
        );
        if (qso.hunterId)
          await upsertSubject(
            client,
            record.programme_slug,
            qso.hunterId,
            'HUNTER',
            qso.workedCallsign,
            qso.workedEntityId ?? null,
            record.entity_type,
          );
        await client.query(
          `INSERT INTO outbox_event(event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
           VALUES ($1,'activity.qso.recorded.v1','activity-service','qso',$2,$3::jsonb,now(),$4)`,
          [randomUUID(), String(row.id), JSON.stringify(qso), randomUUID()],
        );
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        accepted++;
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        await client.query('DELETE FROM activity_qso WHERE id=$1', [row.id]);
        errors.push(
          `record ${recordNumber}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (accepted) {
      const awardRecalculationKey = adifAwardRecalculationKey(
        String(record.activation_id),
        String(normalized[0]?.qso.deduplicationKey),
      );
      await client.query(
        `UPDATE activity_activation SET qso_count=qso_count+$2,
         unique_callsign_count=(SELECT count(DISTINCT worked_callsign) FROM activity_qso WHERE activation_id=$1 AND status<>'VOID'),
         unique_entity_count=(SELECT count(DISTINCT worked_entity_id) FROM activity_qso WHERE activation_id=$1 AND worked_entity_id IS NOT NULL AND status<>'VOID'),
         updated_at=now() WHERE id=$1`,
        [record.activation_id, accepted],
      );
      const awardId = randomUUID();
      await client.query(
        `INSERT INTO activity_job(id,kind,payload,idempotency_key)
         VALUES ($1,'AWARD_RECALCULATE',$2::jsonb,$3) ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          awardId,
          JSON.stringify({
            programmeSlug: record.programme_slug,
            subjectIds: [...awardSubjects],
          }),
          awardRecalculationKey,
        ],
      );
      await client.query(
        `INSERT INTO outbox_event(event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,available_at,correlation_id)
         SELECT id,'activity.award-recalculate.v1','activity-service','activity_job',id,jsonb_build_object('jobId',id),now(),now(),$2
         FROM activity_job WHERE idempotency_key=$1 ON CONFLICT DO NOTHING`,
        [awardRecalculationKey, randomUUID()],
      );
    }
    const rejected = calculateAdifRejectedRecords(
      rows.length,
      accepted,
      normalizationErrorCount,
    );
    const result = await this.finishAdifImport(
      client,
      record,
      rows.length,
      accepted,
      rejected,
      errors,
      'COMPLETED',
    );
    const notificationType =
      rejected || errors.length
        ? 'ADIF_IMPORT_COMPLETED_WITH_ERRORS'
        : 'ADIF_IMPORT_COMPLETED';
    await client.query(
      `INSERT INTO activity_notification(id,recipient_id,notification_type,payload,status,delivered_at,deduplication_key)
       VALUES ($1,$2,$3,$4::jsonb,'DELIVERED',now(),$5) ON CONFLICT DO NOTHING`,
      [
        randomUUID(),
        record.operator_id,
        notificationType,
        JSON.stringify({ importId, result }),
        `adif:${importId}:completed`,
      ],
    );
  }

  private async insertAdifQso(
    client: PoolClient,
    record: JsonRecord,
    importId: string,
    qso: JsonRecord,
  ): Promise<JsonRecord | null> {
    const inserted = await client.query(
      `INSERT INTO activity_qso
       (id,activation_id,programme_slug,operator_id,operator_callsign,hunter_id,hunter_callsign,
        worked_callsign,worked_station_key,worked_entity_id,occurred_at,band,mode,rst,source,
        source_import_id,deduplication_key,raw_payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz,$12,$13,$14,$15,$16,$17,$18::jsonb)
       ON CONFLICT (deduplication_key) DO NOTHING RETURNING *, ${qsoTimestampProjection}`,
      [
        qso.id,
        record.activation_id,
        record.programme_slug,
        record.operator_id,
        record.operator_callsign,
        qso.hunterId ?? null,
        qso.hunterCallsign ?? null,
        qso.workedCallsign,
        qso.workedStationKey,
        qso.workedEntityId ?? null,
        qso.timestamp,
        qso.band,
        qso.mode,
        qso.rst ?? null,
        'adif',
        importId,
        qso.deduplicationKey,
        JSON.stringify(qso),
      ],
    );
    return inserted.rows[0] ?? null;
  }

  private async finishAdifImport(
    client: PoolClient,
    record: JsonRecord,
    seen: number,
    accepted: number,
    rejected: number,
    errors: string[],
    status: string,
  ): Promise<JsonRecord> {
    const updated = await client.query(
      'UPDATE activity_import SET status=$2,records_seen=$3,records_accepted=$4,records_rejected=$5,errors=$6::jsonb,completed_at=now() WHERE id=$1 RETURNING *',
      [record.id, status, seen, accepted, rejected, JSON.stringify(errors)],
    );
    const row = updated.rows[0];
    if (!row) throw new Error(`ADIF import ${String(record.id)} disappeared`);
    if (status === 'FAILED')
      await client.query(
        `INSERT INTO activity_notification(id,recipient_id,notification_type,payload,status,delivered_at,deduplication_key)
         VALUES ($1,$2,'ADIF_IMPORT_FAILED',$3::jsonb,'DELIVERED',now(),$4) ON CONFLICT DO NOTHING`,
        [
          randomUUID(),
          record.activation_id,
          JSON.stringify({
            importId: record.id,
            reason:
              errors[0] === 'uploaded object is not available'
                ? 'object unavailable'
                : (errors[0] ?? 'ADIF import failed'),
          }),
          `adif:${record.id}:failed`,
        ],
      );
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
  }

  private async processPdfRender(client: PoolClient, payload: JsonRecord) {
    const selected = await client.query(
      'SELECT issuance FROM activity_award_issuance WHERE id=$1 FOR UPDATE',
      [payload.issuanceId],
    );
    const issuance = selected.rows[0]?.issuance as JsonRecord | undefined;
    if (!issuance) throw new Error('award issuance not found');
    const spec = issuance.renderSpec as JsonRecord;
    const backgroundAsset = spec.backgroundAsset as JsonRecord;
    const signatureAsset = spec.signatureAsset as JsonRecord;
    const s3 = objectStoreClient();
    const background = await readObject(
      s3,
      String(backgroundAsset.bucket),
      String(backgroundAsset.objectKey),
    );
    const signature = await readObject(
      s3,
      String(signatureAsset.bucket),
      String(signatureAsset.objectKey),
    );
    const values: Record<string, string> = {
      AWARD_NAME: pythonString(issuance.awardName),
      CALLSIGN: pythonString(issuance.callsign),
      PERSON_NAME: pythonString(issuance.personName),
      DATE_OBTAINED: pythonString(issuance.dateObtained),
      MANAGER_NAME: pythonString(issuance.managerName),
    };
    const pdfBytes = await renderCertificatePdf({
      printSpec: spec.printSpec as JsonRecord,
      elements: (Array.isArray(spec.elements)
        ? spec.elements
        : []) as JsonRecord[],
      values,
      background,
      signature,
    });
    const artifact = issuance.artifact as JsonRecord;
    await s3.send(
      new PutObjectCommand({
        Bucket: String(artifact.bucket),
        Key: String(artifact.objectKey),
        Body: pdfBytes,
        ContentType: 'application/pdf',
      }),
    );
    Object.assign(artifact, {
      downloadReady: true,
      renderStatus: 'READY',
      contentSha256: createHash('sha256').update(pdfBytes).digest('hex'),
      byteSize: pdfBytes.length,
      renderedAt: new Date().toISOString(),
    });
    const updated = await client.query(
      'UPDATE activity_award_issuance SET issuance=$2::jsonb WHERE id=$1',
      [issuance.id, JSON.stringify(issuance)],
    );
    if (!updated.rowCount) throw new Error('award issuance disappeared');
    await client.query(
      `INSERT INTO outbox_event(event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
       VALUES ($1,'awards.rendered.v1','awards-service','award_issuance',$2,$3::jsonb,now(),$4)`,
      [randomUUID(), issuance.id, JSON.stringify(issuance), randomUUID()],
    );
  }

  private async processStatisticsRebuild(
    client: PoolClient,
    payload: JsonRecord,
  ) {
    const slugs: string[] = payload.programmeSlug
      ? [String(payload.programmeSlug)]
      : (
          await client.query(
            'SELECT DISTINCT programme_slug FROM activity_activation ORDER BY programme_slug',
          )
        ).rows.map((row) => String(row.programme_slug));
    const algorithmVersion = 'activity-v2';
    for (const programme of slugs) {
      await client.query(
        'DELETE FROM activity_statistic_snapshot WHERE programme_slug=$1 AND algorithm_version=$2',
        [programme, algorithmVersion],
      );
      for (const category of ['ACTIVATOR', 'HUNTER']) {
        const aggregate = await client.query(
          `SELECT count(*) AS participants,coalesce(sum(qso_count),0) AS qsos,
           coalesce(sum(activation_count),0) AS activations,coalesce(max(qso_count),0) AS max_qsos
           FROM activity_subject_aggregate WHERE programme_slug=$1 AND category=$2`,
          [programme, category],
        );
        const row = aggregate.rows[0];
        await client.query(
          `INSERT INTO activity_statistic_snapshot(id,programme_slug,statistic_type,scope_key,metric_values,algorithm_version)
           VALUES ($1,$2,'PROGRAMME_SUMMARY',$3,$4::jsonb,$5)`,
          [
            randomUUID(),
            programme,
            category,
            JSON.stringify({
              participants: Number(row.participants),
              qsos: Number(row.qsos),
              activations: Number(row.activations),
              maxQsos: Number(row.max_qsos),
            }),
            algorithmVersion,
          ],
        );
      }
      for (const [statisticType, column] of [
        ['ENTITY', 'entity_id'],
        ['JURISDICTION', 'jurisdiction_code'],
      ]) {
        const groups = await client.query(
          `SELECT ${column} AS scope_key,count(DISTINCT operator_id) AS participants,
           coalesce(sum(qso_count),0) AS qsos,count(*) AS activations
           FROM activity_activation WHERE programme_slug=$1 AND ${column} IS NOT NULL
           GROUP BY ${column} ORDER BY ${column}`,
          [programme],
        );
        for (const group of groups.rows)
          await client.query(
            `INSERT INTO activity_statistic_snapshot(id,programme_slug,statistic_type,scope_key,metric_values,algorithm_version)
             VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
            [
              randomUUID(),
              programme,
              statisticType,
              String(group.scope_key),
              JSON.stringify({
                participants: Number(group.participants),
                qsos: Number(group.qsos),
                activations: Number(group.activations),
              }),
              algorithmVersion,
            ],
          );
      }
    }
  }

  private async processAwardEvaluation(
    client: PoolClient,
    payload: JsonRecord,
  ) {
    const result = await client.query(
      'SELECT definition FROM activity_award_definition WHERE id=$1',
      [payload.awardId],
    );
    const award = result.rows[0]?.definition;
    if (!award) throw new Error('award definition not found');
    const facts = pythonTruthy(payload.facts)
      ? payload.facts
      : await readSubjectFacts(
          client,
          award.programmeSlug,
          payload.subjectId,
          awardCategory(award),
        );
    const evaluation = evaluateAward(award, payload.subjectId, facts);
    await saveAwardProgress(client, award, payload.subjectId, facts, {
      awardId: award.id,
      subjectId: payload.subjectId,
      conditionMet: evaluation.conditionMet,
      metric: evaluation.metric,
      progress: evaluation.progress,
      levels: evaluation.levels,
      ruleVersion: award.version ?? 1,
    });
    if (evaluation.levels.some((level: JsonRecord) => level.eligible))
      await createAwardNotification(
        client,
        payload.subjectId,
        award,
        evaluation.levels,
        `award-qualified:${award.id}:${award.version ?? 1}:${payload.subjectId}`,
        false,
      );
  }

  private async processAwardRecalculation(
    client: PoolClient,
    payload: JsonRecord,
  ) {
    const result = await client.query(
      `SELECT definition FROM activity_award_definition WHERE programme_slug=$1 AND status IN ('PUBLISHED','RETIRED') ORDER BY code,version`,
      [payload.programmeSlug],
    );
    for (const { definition: award } of result.rows) {
      if (
        pythonTruthy(payload.awardId) &&
        pythonString(award.id) !== pythonString(payload.awardId)
      )
        continue;
      if (
        payload.ruleVersion != null &&
        pythonInt(
          Object.hasOwn(award, 'version') ? award.version : 1,
          'version',
        ) !== pythonInt(payload.ruleVersion, 'ruleVersion')
      )
        continue;
      const requestedSubjects: string[] = Array.isArray(payload.subjectIds)
        ? [
            ...new Set<string>(
              payload.subjectIds.filter(pythonTruthy).map(pythonString),
            ),
          ].sort()
        : [];
      const subjects: string[] = requestedSubjects.length
        ? requestedSubjects
        : (
            await client.query(
              'SELECT DISTINCT subject_id FROM activity_subject_aggregate WHERE programme_slug=$1 AND category=$2 ORDER BY subject_id',
              [payload.programmeSlug, awardCategory(award)],
            )
          ).rows.map((row) => String(row.subject_id));
      for (const subjectId of subjects) {
        const facts = await readSubjectFacts(
          client,
          payload.programmeSlug,
          subjectId,
          awardCategory(award),
        );
        const evaluation = evaluateAward(award, subjectId, facts);
        const snapshot = {
          conditionMet: evaluation.conditionMet,
          metric: evaluation.metric,
          progress: evaluation.progress,
          levels: evaluation.levels,
          ruleVersion: award.version ?? 1,
        };
        await saveAwardProgress(client, award, subjectId, facts, snapshot);
        const eligibleLevels = evaluation.levels
          .filter((level: JsonRecord) => level.eligible)
          .map((level: JsonRecord) => String(level.id))
          .join(',');
        if (eligibleLevels)
          await createAwardNotification(
            client,
            subjectId,
            award,
            evaluation.levels,
            `award-qualified:${award.id}:${award.version ?? 1}:${subjectId}:${eligibleLevels}`,
          );
      }
    }
  }

  async retryWorkJob(job: ClaimedJob, error: unknown, delaySeconds: number) {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const message =
        error instanceof Error ? error.name.slice(0, 80) : 'worker error';
      const retried = await client.query(
        `UPDATE activity_job SET status='QUEUED',available_at=now()+make_interval(secs=>$3),lease_expires_at=NULL,lease_token=NULL,last_error=$4 WHERE id=$1 AND status='RUNNING' AND lease_token=$2 RETURNING id`,
        [job.id, job.leaseToken, delaySeconds, message],
      );
      if (!retried.rowCount)
        throw new Error('worker lease was lost before retry');
      await client.query('COMMIT');
    } catch (failure) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw failure;
    } finally {
      client.release();
    }
  }

  async failWorkJob(
    job: ClaimedJob,
    error: unknown,
    subject: string,
    workType: string,
    deliveryCount: number,
  ): Promise<void> {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const message =
        error instanceof Error ? error.name.slice(0, 80) : 'worker error';
      const failed = await client.query(
        `UPDATE activity_job SET status='FAILED',completed_at=now(),lease_expires_at=NULL,lease_token=NULL,last_error=$3
         WHERE id=$1 AND status='RUNNING' AND lease_token=$2 RETURNING id`,
        [job.id, job.leaseToken, message],
      );
      if (!failed.rowCount)
        throw new Error('worker lease was lost before dead-lettering');
      await client.query(
        `INSERT INTO activity_work_dead_letter
          (id,work_id,work_type,subject,delivery_count,error_category)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          randomUUID(),
          job.id,
          workType,
          subject.slice(0, 255),
          Math.max(1, deliveryCount),
          message || 'worker error',
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
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

async function readSubjectFacts(
  client: PoolClient,
  programme: string,
  subjectId: string,
  category: string,
): Promise<JsonRecord> {
  const result = await client.query(
    `SELECT qso_count,activation_count,unique_callsign_count,unique_entity_count,last_entity_type
     FROM activity_subject_aggregate WHERE programme_slug=$1 AND subject_id=$2 AND category=$3`,
    [programme, subjectId, category],
  );
  const row = result.rows[0];
  return row
    ? {
        qsoCount: parsePageTotal(row.qso_count),
        activationCount: parsePageTotal(row.activation_count),
        uniqueCallsignCount: parsePageTotal(row.unique_callsign_count),
        uniqueEntityCount: parsePageTotal(row.unique_entity_count),
        entityType: row.last_entity_type,
      }
    : {
        qsoCount: 0,
        activationCount: 0,
        uniqueCallsignCount: 0,
        uniqueEntityCount: 0,
        entityType: null,
      };
}

async function saveAwardProgress(
  client: PoolClient,
  award: JsonRecord,
  subjectId: string,
  facts: JsonRecord,
  evaluation: JsonRecord,
) {
  await client.query(
    `INSERT INTO activity_award_progress(award_id,award_version,subject_id,category,facts,evaluation)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)
     ON CONFLICT (award_id,award_version,subject_id) DO UPDATE SET facts=EXCLUDED.facts,evaluation=EXCLUDED.evaluation,computed_at=now()`,
    [
      award.id,
      Number(award.version ?? 1),
      subjectId,
      awardCategory(award),
      stringifyJsonWithBigInts(facts),
      stringifyJsonWithBigInts(evaluation),
    ],
  );
}

function awardCategory(award: JsonRecord) {
  return Object.hasOwn(award, 'category') ? award.category : 'HUNTER';
}

async function createAwardNotification(
  client: PoolClient,
  subjectId: string,
  award: JsonRecord,
  levels: JsonRecord[],
  deduplicationKey: string,
  includeAwardCode = true,
) {
  const payload: JsonRecord = { awardId: award.id, levels };
  if (includeAwardCode) payload.awardCode = award.code;
  await client.query(
    `INSERT INTO activity_notification(id,recipient_id,notification_type,payload,status,delivered_at,deduplication_key)
     VALUES ($1,$2,'AWARD_QUALIFIED',$3::jsonb,'DELIVERED',now(),$4) ON CONFLICT DO NOTHING`,
    [randomUUID(), subjectId, JSON.stringify(payload), deduplicationKey],
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
    timestamp: normalizeTimestamp(row.occurred_at_iso ?? row.occurred_at),
    band: row.band,
    mode: row.mode,
    rst: row.rst,
    source: row.source,
    status: row.status,
    deduplicationKey: row.deduplication_key,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function objectStoreClient() {
  return new S3Client({
    endpoint:
      process.env.MYOTA_OBJECT_STORAGE_ENDPOINT ?? 'http://seaweedfs:8333',
    region: process.env.MYOTA_OBJECT_STORAGE_REGION ?? 'us-east-1',
    forcePathStyle:
      (process.env.MYOTA_OBJECT_STORAGE_ADDRESSING_STYLE ?? 'path') === 'path',
    credentials: {
      accessKeyId: process.env.MYOTA_OBJECT_STORAGE_ACCESS_KEY ?? 'myota-s3',
      secretAccessKey:
        process.env.MYOTA_OBJECT_STORAGE_SECRET_KEY ?? 'myota-s3-dev-only',
    },
  });
}

function date(value: unknown) {
  return value == null
    ? null
    : new Date(value as string | number | Date).toISOString();
}

async function readObject(client: S3Client, bucket: string, key: string) {
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!response.Body) throw new Error(`award asset is missing: ${key}`);
  return Buffer.from(await response.Body.transformToByteArray());
}

async function scanAdifContent(content: Buffer, filename: string) {
  if (content.length > MAX_UPLOAD_BYTES)
    throw new Error(`${filename} exceeds the configured upload limit`);
  const eicar = Buffer.from(
    'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
  );
  if (content.includes(eicar))
    throw new Error('malware scan rejected the upload');
  const endpoint = process.env.MYOTA_CLAMAV_URL?.trim();
  if (!endpoint) return;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-upload-name': filename,
      },
      body: new Uint8Array(content),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('malware scanner rejected the upload');
  } catch {
    throw new Error('malware scanner is unavailable; import was rejected');
  }
}
