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
import type { AccessTokenClaims } from '@app/platform/access-token.js';
import { assertReviewCoverage } from './geodata-entity-mutation.repository.js';

@Injectable()
export class GeodataImportMutationRepository {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async resolveConflation(
    candidateId: string,
    key: string | undefined,
    body: Record<string, unknown>,
  ) {
    const decision = typeof body.decision === 'string' ? body.decision : '';
    if (!['MERGED', 'KEPT_SEPARATE', 'IGNORED', 'OPEN'].includes(decision))
      throw new BadRequestException(
        'decision must be MERGED, KEPT_SEPARATE, IGNORED, or OPEN',
      );
    const reviewerId =
      typeof body.reviewerId === 'string' ? body.reviewerId : '';
    if (!reviewerId) throw new BadRequestException('reviewerId is required');
    if (
      body.survivorEntityId !== undefined &&
      (typeof body.survivorEntityId !== 'string' ||
        !isUuid(body.survivorEntityId))
    )
      throw new BadRequestException('survivorEntityId must be a UUID');
    const note =
      typeof body.note === 'string' ? body.note.slice(0, 2000) : null;
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      if (key) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('geodata-conflation:' || $1,0))",
          [key],
        );
        const prior = await client.query(
          'SELECT response FROM idempotency_record WHERE service=$1 AND key=$2',
          ['geodata-conflation', key],
        );
        if (prior.rows[0]) {
          await client.query('COMMIT');
          return prior.rows[0].response;
        }
      }
      const selected = await client.query(
        'SELECT * FROM conflation_candidate WHERE id=$1 FOR UPDATE',
        [candidateId],
      );
      const previous = selected.rows[0];
      if (!previous)
        throw new NotFoundException('conflation candidate not found');
      const occurredAt = new Date().toISOString();
      const history = Array.isArray(previous.resolution_history)
        ? [...previous.resolution_history]
        : [];
      const entry = {
        decision,
        previousDecision: previous.resolution,
        reviewerId,
        note,
        occurredAt,
      };
      history.push(entry);
      await client.query(
        `UPDATE conflation_candidate SET resolution=$2,survivor_entity_id=$3,
         resolution_history=$4::jsonb,resolved_by=$5,resolved_at=now()
         WHERE id=$1`,
        [
          candidateId,
          decision,
          typeof body.survivorEntityId === 'string'
            ? body.survivorEntityId
            : null,
          JSON.stringify(history),
          isUuid(reviewerId) ? reviewerId : null,
        ],
      );
      const item = {
        id: candidateId,
        leftEntityId: String(previous.left_entity_id),
        rightEntityId: String(previous.right_entity_id),
        score: Number(previous.similarity),
        signals: previous.reason,
        resolution: decision,
        resolutionHistory: history,
        survivorEntityId:
          typeof body.survivorEntityId === 'string'
            ? body.survivorEntityId
            : null,
        reviewerId,
        resolvedAt: occurredAt,
        updatedAt: occurredAt,
      };
      await client.query(
        `INSERT INTO outbox_event
         (event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
         VALUES ($1,'geodata.conflation.resolved.v1','geodata-service','conflation_candidate',$2,$3::jsonb,now(),$4)`,
        [randomUUID(), candidateId, JSON.stringify(item), randomUUID()],
      );
      if (key)
        await client.query(
          'INSERT INTO idempotency_record(service,key,response) VALUES ($1,$2,$3::jsonb)',
          ['geodata-conflation', key, JSON.stringify(item)],
        );
      await client.query('COMMIT');
      return item;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async finalizeImport(
    runId: string,
    key: string | undefined,
    body: Record<string, unknown>,
  ) {
    const processedBy =
      (typeof body.processedBy === 'string' && body.processedBy) ||
      (typeof body.actor === 'string' && body.actor) ||
      'administrator';
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      if (key) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('geodata-import-finalize:' || $1,0))",
          [key],
        );
        const previous = await client.query(
          'SELECT response FROM idempotency_record WHERE service=$1 AND key=$2',
          ['geodata-import-finalize', key],
        );
        if (previous.rows[0]) {
          await client.query('COMMIT');
          return previous.rows[0].response;
        }
      }
      const found = await client.query(
        'SELECT status,processed_by FROM import_run WHERE id=$1 FOR UPDATE',
        [runId],
      );
      const run = found.rows[0];
      if (!run) throw new BadRequestException('geodata import not found');
      if (['QUEUED', 'PROCESSING'].includes(run.status))
        throw new BadRequestException(
          'an import cannot be finalized while it is still processing',
        );
      let stagedRecordsDiscarded = 0;
      let processingQueuesDiscarded = 0;
      if (run.status !== 'PROCESSED') {
        const counts = await client.query(
          `SELECT (SELECT count(*)::integer FROM geodata_import_candidate WHERE import_run_id=$1) AS candidates,
                  (SELECT count(*)::integer FROM geodata_import_candidate_stage WHERE import_run_id=$1) AS staged,
                  (SELECT count(*)::integer FROM geodata_import_processing_queue WHERE import_run_id=$1) AS queues`,
          [runId],
        );
        stagedRecordsDiscarded =
          Number(counts.rows[0].candidates) + Number(counts.rows[0].staged);
        processingQueuesDiscarded = Number(counts.rows[0].queues);
        await client.query(
          "SELECT set_config('myota.geodata_writer','row-v1',true)",
        );
        await client.query(
          'DELETE FROM geodata_import_processing_queue WHERE import_run_id=$1',
          [runId],
        );
        await client.query(
          'DELETE FROM geodata_import_candidate WHERE import_run_id=$1',
          [runId],
        );
        await client.query(
          'DELETE FROM geodata_import_candidate_stage WHERE import_run_id=$1',
          [runId],
        );
        await client.query(
          `UPDATE import_run SET status='PROCESSED',processed_at=now(),processed_by=$2,
           last_error=NULL,heartbeat_at=NULL,lease_until=NULL WHERE id=$1`,
          [runId, processedBy],
        );
        await client.query(
          `INSERT INTO outbox_event
           (event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
           VALUES ($1,'geodata.import.processed.v1','geodata-service','import_run',$2,$3::jsonb,now(),$4)`,
          [
            randomUUID(),
            runId,
            JSON.stringify({
              importRunId: runId,
              processedBy,
              stagedRecordsDiscarded,
              processingQueuesDiscarded,
            }),
            randomUUID(),
          ],
        );
      }
      const response = {
        importRunId: runId,
        processedBy:
          run.status === 'PROCESSED' ? run.processed_by : processedBy,
        stagedRecordsDiscarded,
        processingQueuesDiscarded,
        finalized: true,
      };
      if (key)
        await client.query(
          'INSERT INTO idempotency_record(service,key,response) VALUES ($1,$2,$3::jsonb)',
          ['geodata-import-finalize', key, JSON.stringify(response)],
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

  async cancelImport(runId: string, actor: string) {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT status,source_metadata,cancellation_requested_at,cancellation_requested_by
         FROM import_run WHERE id=$1 FOR UPDATE`,
        [runId],
      );
      const run = result.rows[0];
      if (!run) throw new BadRequestException('geodata import not found');
      if (run.status === 'CANCELLED' || run.status === 'CANCELLING') {
        await client.query('COMMIT');
        return {
          status: run.status,
          httpStatus: run.status === 'CANCELLING' ? 202 : 200,
          sourceMetadata: run.source_metadata,
        };
      }
      if (!['UPLOAD_PENDING', 'QUEUED', 'PROCESSING'].includes(run.status))
        throw new BadRequestException(
          run.status.startsWith('PREPROCESSED')
            ? 'preprocessing has finished; reviewed imports cannot be cancelled'
            : `an import in ${run.status.toLowerCase()} state cannot be cancelled`,
        );
      const active = run.status === 'PROCESSING';
      const nextStatus = active ? 'CANCELLING' : 'CANCELLED';
      const eventType = active
        ? 'geodata.import.cancellation-requested.v1'
        : 'geodata.import.cancelled.v1';
      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await client.query(
        `UPDATE import_run SET status=$2,cancellation_requested_at=now(),
         cancellation_requested_by=$3,
         completed_at=CASE WHEN $2='CANCELLED' THEN now() ELSE completed_at END,
         heartbeat_at=CASE WHEN $2='CANCELLED' THEN NULL ELSE heartbeat_at END,
         lease_until=CASE WHEN $2='CANCELLED' THEN NULL ELSE lease_until END,
         last_error=CASE WHEN $2='CANCELLED' THEN NULL ELSE last_error END,
         stats=CASE WHEN $2='CANCELLED' THEN '{"preprocessed":0,"created":0,"updated":0,"skipped":0,"errors":0,"disappeared":0}'::jsonb ELSE stats END
         WHERE id=$1`,
        [runId, nextStatus, actor],
      );
      if (!active)
        await client.query(
          'DELETE FROM geodata_import_candidate WHERE import_run_id=$1',
          [runId],
        );
      if (!active)
        await client.query(
          'DELETE FROM geodata_import_candidate_stage WHERE import_run_id=$1',
          [runId],
        );
      await client.query(
        `INSERT INTO outbox_event
         (event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
         VALUES ($1,$2,'geodata-service','import_run',$3,$4::jsonb,now(),$5)`,
        [
          randomUUID(),
          eventType,
          runId,
          JSON.stringify({
            importRunId: runId,
            ...(active ? { requestedBy: actor } : {}),
          }),
          randomUUID(),
        ],
      );
      await client.query('COMMIT');
      return {
        status: nextStatus,
        httpStatus: active ? 202 : 200,
        sourceMetadata: run.source_metadata,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
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
      typeof body.reviewerId === 'string' ? body.reviewerId : '';
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
    claims: AccessTokenClaims,
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
      typeof body.processorId === 'string' ? body.processorId : '';
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
      }
      const selected = await client.query(
        `SELECT c.id,c.programme_slug,c.entity_type_codes,c.entity_payload,
          c.validation_status,c.processing_queue_id,
          previous_queue.status AS previous_queue_status,
          EXISTS (
            SELECT 1 FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(previous_queue.result->'errors')='array'
                THEN previous_queue.result->'errors' ELSE '[]'::jsonb END
            ) AS failed(error)
            WHERE failed.error->>'candidateId'=c.id::text
          ) AS failed_in_previous_queue
         FROM geodata_import_candidate c
         LEFT JOIN geodata_import_processing_queue previous_queue
           ON previous_queue.id=c.processing_queue_id
         WHERE c.import_run_id=$1 AND c.id=ANY($2::uuid[])
         FOR UPDATE OF c`,
        [runId, rawIds],
      );
      if (selected.rows.length !== rawIds.length)
        throw new BadRequestException(
          'one or more candidates do not belong to this import run',
        );
      if (targetStatus === 'APPROVED')
        for (const row of selected.rows) {
          const properties = isRecord(row.entity_payload)
            ? row.entity_payload
            : {};
          assertReviewCoverage(claims, {
            programme_slug: row.programme_slug,
            jurisdiction: properties.jurisdiction,
            entity_type_codes: row.entity_type_codes,
            public_properties: properties,
          });
        }
      if (key) {
        const previous = await client.query(
          'SELECT response FROM idempotency_record WHERE service=$1 AND key=$2',
          ['geodata-import-promotion', key],
        );
        if (previous.rows[0]) {
          await client.query('COMMIT');
          return previous.rows[0].response;
        }
      }
      if (
        selected.rows.some(
          (row) =>
            row.validation_status === 'PROCESSED' ||
            (row.processing_queue_id &&
              !(
                row.validation_status === 'CONFIRMED' &&
                row.previous_queue_status === 'FAILED' &&
                row.failed_in_previous_queue === true
              )),
        )
      )
        throw new BadRequestException(
          'candidates must be unqueued or listed as failed in a prior failed queue',
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

  async redriveImportProcessingQueue(
    runId: string,
    queueId: string,
    key: string | undefined,
    requestedBy: string,
    reasonValue: unknown,
  ) {
    const reason = typeof reasonValue === 'string' ? reasonValue.trim() : '';
    if (!reason || reason.length > 1000)
      throw new BadRequestException(
        'reason is required and must be at most 1000 characters',
      );
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      if (key) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('geodata-import-redrive:' || $1,0))",
          [key],
        );
        const previous = await client.query(
          'SELECT response FROM idempotency_record WHERE service=$1 AND key=$2',
          ['geodata-import-redrive', key],
        );
        if (previous.rows[0]) {
          await client.query('COMMIT');
          return previous.rows[0].response;
        }
      }
      const selected = await client.query(
        `SELECT id,import_run_id,candidate_ids,target_status,requested_by,status,
          requested_at,started_at,completed_at,attempt_count,result,error,job_metadata
         FROM geodata_import_processing_queue
         WHERE id=$1 AND import_run_id=$2 FOR UPDATE`,
        [queueId, runId],
      );
      const previous = selected.rows[0];
      if (!previous)
        throw new NotFoundException('import processing queue not found');
      if (previous.status !== 'FAILED')
        throw new BadRequestException(
          'only failed promotion queues can be redriven',
        );

      const metadata = isRecord(previous.job_metadata)
        ? previous.job_metadata
        : {};
      const priorHistory = Array.isArray(metadata.redriveHistory)
        ? metadata.redriveHistory
        : [];
      const history = [
        ...priorHistory,
        {
          requestedAt: new Date().toISOString(),
          requestedBy,
          reason,
          previousAttemptCount: Number(previous.attempt_count),
          previousError: previous.error,
          previousResult: previous.result,
        },
      ].slice(-20);
      const updatedMetadata = { ...metadata, redriveHistory: history };
      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await client.query(
        `UPDATE geodata_import_processing_queue SET status='QUEUED',
          requested_by=$3,requested_at=now(),started_at=NULL,completed_at=NULL,
          attempt_count=0,heartbeat_at=NULL,lease_until=NULL,error=NULL,
          result='{}'::jsonb,job_metadata=$4::jsonb,work_dispatched_at=now()
         WHERE id=$1 AND import_run_id=$2 AND status='FAILED'`,
        [queueId, runId, requestedBy, JSON.stringify(updatedMetadata)],
      );
      const candidateIds = Array.isArray(previous.candidate_ids)
        ? previous.candidate_ids
        : JSON.parse(String(previous.candidate_ids));
      const response = {
        id: queueId,
        importRunId: runId,
        candidateIds,
        targetStatus: previous.target_status,
        requestedBy,
        status: 'QUEUED',
        requestedAt: new Date().toISOString(),
        redriven: true,
      };
      await client.query(
        `INSERT INTO outbox_event
         (event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
         VALUES ($1,'geodata.import.processing.queued.v1','geodata-service','import_processing_queue',$2,$3::jsonb,now(),$4)`,
        [randomUUID(), queueId, JSON.stringify({ queueId }), randomUUID()],
      );
      if (key)
        await client.query(
          'INSERT INTO idempotency_record(service,key,response) VALUES ($1,$2,$3::jsonb)',
          ['geodata-import-redrive', key, JSON.stringify(response)],
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

  private async connect(): Promise<PoolClient> {
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

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
