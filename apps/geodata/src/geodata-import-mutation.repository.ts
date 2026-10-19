import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';

@Injectable()
export class GeodataImportMutationRepository {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

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
