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
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import {
  normalizeQso,
  type JsonRecord,
} from '../../activity/src/activity-domain.js';
import { evaluateAward } from '../../activity/src/award-domain.js';

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
        `SELECT id FROM activity_job WHERE kind=ANY($1::text[]) AND available_at<=now()
         AND (status='QUEUED' OR (status='RUNNING' AND lease_expires_at<now()))
         ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
        [
          [
            'QSO_INGESTION',
            'AWARD_EVALUATION',
            'AWARD_RECALCULATE',
            'PDF_RENDER',
            'STATISTICS_REBUILD',
          ],
        ],
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
      if (job.kind === 'QSO_INGESTION') {
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
    const pdfBytes = await renderCertificate(issuance, background, signature);
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
    const facts =
      payload.facts ??
      (await readSubjectFacts(
        client,
        award.programmeSlug,
        payload.subjectId,
        award.category ?? 'HUNTER',
      ));
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
      if (payload.awardId && String(award.id) !== String(payload.awardId))
        continue;
      if (
        payload.ruleVersion != null &&
        Number(award.version ?? 1) !== Number(payload.ruleVersion)
      )
        continue;
      const subjects: string[] = payload.subjectIds?.length
        ? payload.subjectIds.map(String)
        : (
            await client.query(
              'SELECT DISTINCT subject_id FROM activity_subject_aggregate WHERE programme_slug=$1 AND category=$2 ORDER BY subject_id',
              [payload.programmeSlug, award.category ?? 'HUNTER'],
            )
          ).rows.map((row) => String(row.subject_id));
      for (const subjectId of subjects) {
        const facts = await readSubjectFacts(
          client,
          payload.programmeSlug,
          subjectId,
          award.category ?? 'HUNTER',
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
          `INSERT INTO activity_work_dead_letter(id,work_id,work_type,subject,delivery_count,error_category) VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            randomUUID(),
            job.id,
            `activity.${job.kind.toLowerCase().replaceAll('_', '-')}.v1`,
            `myota.work.activity.${job.kind.toLowerCase().replaceAll('_', '-')}.v1:${job.id}`,
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
      award.category ?? 'HUNTER',
      JSON.stringify(facts),
      JSON.stringify(evaluation),
    ],
  );
}

async function createAwardNotification(
  client: PoolClient,
  subjectId: string,
  award: JsonRecord,
  levels: JsonRecord[],
  deduplicationKey: string,
) {
  await client.query(
    `INSERT INTO activity_notification(id,recipient_id,notification_type,payload,status,delivered_at,deduplication_key)
     VALUES ($1,$2,'AWARD_QUALIFIED',$3::jsonb,'DELIVERED',now(),$4) ON CONFLICT DO NOTHING`,
    [
      randomUUID(),
      subjectId,
      JSON.stringify({ awardId: award.id, awardCode: award.code, levels }),
      deduplicationKey,
    ],
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

async function readObject(client: S3Client, bucket: string, key: string) {
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!response.Body) throw new Error(`award asset is missing: ${key}`);
  return Buffer.from(await response.Body.transformToByteArray());
}

async function renderCertificate(
  issuance: JsonRecord,
  background: Buffer,
  signature: Buffer,
) {
  const spec = issuance.renderSpec as JsonRecord;
  const printSpec = spec.printSpec as JsonRecord;
  const page = String(printSpec.page ?? 'A4').toUpperCase();
  const orientation = String(printSpec.orientation ?? 'PORTRAIT').toUpperCase();
  let [widthMm, heightMm] = page === 'LETTER' ? [215.9, 279.4] : [210, 297];
  if (orientation === 'LANDSCAPE') [widthMm, heightMm] = [heightMm, widthMm];
  const width = (widthMm / 25.4) * 72;
  const height = (heightMm / 25.4) * 72;
  const document = await PDFDocument.create();
  const sheet = document.addPage([width, height]);
  const backgroundImage = await embedImage(document, background);
  sheet.drawImage(backgroundImage, { x: 0, y: 0, width, height });
  const signatureImage = await embedImage(document, signature);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const values: Record<string, string> = {
    AWARD_NAME: String(issuance.awardName ?? ''),
    CALLSIGN: String(issuance.callsign ?? ''),
    PERSON_NAME: String(issuance.personName ?? ''),
    DATE_OBTAINED: String(issuance.dateObtained ?? ''),
    MANAGER_NAME: String(issuance.managerName ?? ''),
  };
  const elements = Array.isArray(spec.elements) ? spec.elements : [];
  for (const item of elements as JsonRecord[]) {
    const x = Number(item.x) * width;
    const boxWidth = Number(item.width) * width;
    const boxHeight = Number(item.height) * height;
    const top = Number(item.y) * height;
    const y = height - top - boxHeight;
    if (item.kind === 'MANAGER_SIGNATURE') {
      const scale = Math.min(
        boxWidth / signatureImage.width,
        boxHeight / signatureImage.height,
      );
      const imageWidth = signatureImage.width * scale;
      const imageHeight = signatureImage.height * scale;
      sheet.drawImage(signatureImage, {
        x: x + (boxWidth - imageWidth) / 2,
        y: y + (boxHeight - imageHeight) / 2,
        width: imageWidth,
        height: imageHeight,
      });
      continue;
    }
    const text = (values[String(item.kind)] ?? String(item.label ?? '')).slice(
      0,
      200,
    );
    if (!text) continue;
    let fontSize = Math.max(8, boxHeight * 0.55);
    const textWidth = font.widthOfTextAtSize(text, fontSize);
    if (textWidth > boxWidth)
      fontSize = Math.max(7, (fontSize * boxWidth) / textWidth);
    const drawnWidth = font.widthOfTextAtSize(text, fontSize);
    sheet.drawText(text, {
      x: x + Math.max(0, (boxWidth - drawnWidth) / 2),
      y: y + Math.max(0, (boxHeight - fontSize) / 2),
      size: fontSize,
      font,
      color: rgb(0, 0, 0),
      maxWidth: boxWidth,
    });
  }
  return Buffer.from(await document.save());
}

async function embedImage(document: PDFDocument, content: Buffer) {
  if (
    content
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return document.embedPng(content);
  if (content[0] === 0xff && content[1] === 0xd8)
    return document.embedJpg(content);
  throw new Error('certificate asset must be PNG or JPEG');
}
