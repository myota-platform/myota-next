import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
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
import { parsePageTotal, type PageInteger } from '@app/platform/pagination.js';
import { pythonKeyErrorDetail } from '@app/platform/python-strings.js';
import { pythonTruthy } from '@app/platform/python-truthiness.js';
import { utcTimestamp } from '@app/platform/utc-timestamp.js';
import {
  GeodataPromotionRepository,
  isCandidateConflict,
  type PromotionQueue,
} from '../../geodata-worker/src/geodata-promotion.repository.js';
import {
  ProgrammeEntityIdentifierError,
  suggestProgrammeEntityIdentifier,
  type ManualEntityIdentifierAssignment,
} from '../../geodata-worker/src/programme-entity-identifier.js';
import { assertReviewCoverage } from './geodata-entity-mutation.repository.js';
import {
  lockRequest,
  readRequestResponse,
  replayRequest,
  requestResponse,
} from './geodata-request-idempotency.js';

const MAX_SYNCHRONOUS_IMPORT_CANDIDATES = 300;

@Injectable()
export class GeodataImportMutationRepository {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
    private readonly promotion: GeodataPromotionRepository,
  ) {}

  async suggestEntityIdentifier(
    importRunId: string,
    candidateId: string,
    body: Record<string, unknown>,
  ) {
    if (!isUuid(importRunId) || !isUuid(candidateId))
      throw new NotFoundException(pythonKeyErrorDetail(candidateId));
    const selected = await this.connect();
    let candidate:
      | {
          programme_slug: string | null;
          entity_payload: unknown;
          existing_identifier: string | null;
        }
      | undefined;
    try {
      const result = await selected.query(
        `SELECT c.programme_slug,c.entity_payload,e.entity_identifier AS existing_identifier
           FROM geodata_import_candidate c
           LEFT JOIN geodata_entity e ON e.id=c.existing_entity_id
          WHERE c.import_run_id=$1 AND c.id=$2`,
        [importRunId, candidateId],
      );
      candidate = result.rows[0];
    } finally {
      selected.release();
    }
    if (!candidate)
      throw new NotFoundException(pythonKeyErrorDetail(candidateId));
    if (candidate.existing_identifier)
      return {
        entityIdentifier: candidate.existing_identifier,
        assigned: true,
        reserved: true,
      };
    if (!candidate.programme_slug)
      throw new BadRequestException(
        'select a programme before requesting an entity ID suggestion',
      );
    const policies = await this.promotion.loadProgrammeNumberingPolicies(
      importRunId,
      [candidateId],
    );
    const policy = policies.get(candidate.programme_slug);
    if (!policy)
      throw new BadRequestException(
        'the selected programme has no entity ID numbering policy',
      );
    const properties = isRecord(candidate.entity_payload)
      ? candidate.entity_payload
      : {};
    const manualAssignment: ManualEntityIdentifierAssignment = {};
    if (body.qualifier !== undefined)
      manualAssignment.qualifier = body.qualifier;
    try {
      // A suggestion is deliberately advisory: the serial can be claimed by
      // another administrator before promotion. Allocation rechecks it in the
      // promotion transaction and reports a recoverable conflict.
      const qualifier = suggestProgrammeEntityIdentifier(
        policy,
        properties,
        manualAssignment,
        1,
      ).qualifier;
      const scope = qualifier ?? '';
      const client = await this.connect();
      let nextSerial: number;
      try {
        const latest = await client.query(
          `SELECT COALESCE(MAX(serial_number),0)+1 AS next_serial
             FROM geodata_entity_identifier_reservation
            WHERE programme_slug=$1 AND qualifier_scope=$2`,
          [candidate.programme_slug, scope],
        );
        nextSerial = Number(latest.rows[0]?.next_serial ?? 1);
      } finally {
        client.release();
      }
      return {
        ...suggestProgrammeEntityIdentifier(
          policy,
          properties,
          manualAssignment,
          nextSerial,
        ),
        assigned: false,
        reserved: false,
      };
    } catch (error) {
      if (error instanceof ProgrammeEntityIdentifierError)
        throw new BadRequestException(error.message);
      throw error;
    }
  }

  async resolveConflation(
    candidateId: string,
    key: string | undefined,
    body: Record<string, unknown>,
    requestHash?: string,
  ) {
    if (key && requestHash) {
      const replay = await replayRequest(
        () => this.connect(),
        'geodata-conflation',
        key,
        requestHash,
      );
      if (replay.found) return replay.response;
    }
    const decision = typeof body.decision === 'string' ? body.decision : '';
    if (!['MERGED', 'KEPT_SEPARATE', 'IGNORED', 'OPEN'].includes(decision))
      throw new BadRequestException(
        'decision must be MERGED, KEPT_SEPARATE, IGNORED, or OPEN',
      );
    const reviewerId = body.reviewerId;
    if (!pythonTruthy(reviewerId))
      throw new BadRequestException('reviewerId is required');
    if (
      body.survivorEntityId !== undefined &&
      (typeof body.survivorEntityId !== 'string' ||
        !isUuid(body.survivorEntityId))
    )
      throw new BadRequestException('survivorEntityId must be a UUID');
    const note = body.note === undefined ? null : body.note;
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      if (key) {
        await lockRequest(client, key);
        const prior = await readRequestResponse(
          client,
          'geodata-conflation',
          key,
          requestHash,
        );
        if (prior.found) {
          await client.query('COMMIT');
          return prior.response;
        }
      }
      const selected = await client.query(
        `SELECT c.*,l.programme_slug,
           to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_iso
         FROM conflation_candidate c
         JOIN geodata_entity l ON l.id=c.left_entity_id
         WHERE c.id=$1 FOR UPDATE OF c`,
        [candidateId],
      );
      const previous = selected.rows[0];
      if (!previous)
        throw new NotFoundException(pythonKeyErrorDetail(candidateId));
      const responseId = String(previous.id).replaceAll('-', '');
      const occurredAt = await utcTimestamp(client);
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
      const updated = await client.query(
        `UPDATE conflation_candidate SET resolution=$2,survivor_entity_id=$3,
         resolution_history=$4::jsonb,resolved_by=$5,resolved_at=now(),updated_at=now()
         WHERE id=$1
         RETURNING to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_iso`,
        [
          candidateId,
          decision,
          typeof body.survivorEntityId === 'string'
            ? body.survivorEntityId
            : null,
          stringifyJsonWithBigInts(history),
          typeof reviewerId === 'string' && isUuid(reviewerId)
            ? reviewerId
            : null,
        ],
      );
      const item = {
        id: responseId,
        programmeSlug: previous.programme_slug,
        leftEntityId: String(previous.left_entity_id),
        rightEntityId: String(previous.right_entity_id),
        score: Number(previous.similarity),
        signals: previous.reason,
        resolution: decision,
        resolutionHistory: history,
        createdAt: previous.created_at_iso,
        updatedAt: updated.rows[0]?.updated_at_iso,
        survivorEntityId:
          typeof body.survivorEntityId === 'string'
            ? body.survivorEntityId
            : null,
        reviewerId,
        resolvedAt: occurredAt,
      };
      await client.query(
        `INSERT INTO outbox_event
         (event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
         VALUES ($1,'geodata.conflation.resolved.v1','geodata-service','conflation_candidate',$2,$3::jsonb,now(),$4)`,
        [
          randomUUID(),
          responseId,
          stringifyJsonWithBigInts(item),
          randomUUID(),
        ],
      );
      if (key)
        await client.query(
          'INSERT INTO idempotency_record(service,key,response) VALUES ($1,$2,$3::jsonb)',
          [
            'geodata-conflation',
            key,
            stringifyJsonWithBigInts(requestResponse(item, requestHash)),
          ],
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
    requestHash?: string,
  ) {
    if (key && requestHash) {
      const replay = await replayRequest(
        () => this.connect(),
        'geodata-import-finalize',
        key,
        requestHash,
      );
      if (replay.found) return replay.response;
    }
    const processedBy =
      (typeof body.processedBy === 'string' && body.processedBy) ||
      (typeof body.actor === 'string' && body.actor) ||
      'administrator';
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      if (key) {
        await lockRequest(client, key);
        const previous = await readRequestResponse(
          client,
          'geodata-import-finalize',
          key,
          requestHash,
        );
        if (previous.found) {
          await client.query('COMMIT');
          return previous.response;
        }
      }
      const found = await client.query(
        'SELECT status,processed_by FROM import_run WHERE id=$1 FOR UPDATE',
        [runId],
      );
      const run = found.rows[0];
      if (!run)
        throw new NotFoundException(
          pythonKeyErrorDetail(`import run ${runId} not found`),
        );
      if (['QUEUED', 'PROCESSING'].includes(run.status))
        throw new BadRequestException(
          'an import cannot be finalized while it is still processing',
        );
      let stagedRecordsDiscarded: PageInteger = 0;
      let processingQueuesDiscarded: PageInteger = 0;
      if (run.status !== 'PROCESSED') {
        const counts = await client.query(
          `SELECT (SELECT count(*) FROM geodata_import_candidate WHERE import_run_id=$1) AS candidates,
                  (SELECT count(*) FROM geodata_import_candidate_stage WHERE import_run_id=$1) AS staged,
                  (SELECT count(*) FROM geodata_import_processing_queue WHERE import_run_id=$1) AS queues`,
          [runId],
        );
        const candidatesDiscarded = parsePageTotal(counts.rows[0].candidates);
        const stagedCount = parsePageTotal(counts.rows[0].staged);
        stagedRecordsDiscarded = parsePageTotal(
          BigInt(candidatesDiscarded) + BigInt(stagedCount),
        );
        processingQueuesDiscarded = parsePageTotal(counts.rows[0].queues);
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
            stringifyJsonWithBigInts({
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
          [
            'geodata-import-finalize',
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
      if (!run)
        throw new NotFoundException(
          pythonKeyErrorDetail('import run not found'),
        );
      if (run.status === 'CANCELLED' || run.status === 'CANCELLING') {
        await client.query('COMMIT');
        return {
          status: run.status,
          httpStatus: run.status === 'CANCELLING' ? 202 : 200,
          sourceMetadata: publicSourceMetadata(run.source_metadata),
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
          stringifyJsonWithBigInts({
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
        sourceMetadata: publicSourceMetadata(run.source_metadata),
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
    requestHash?: string,
  ) {
    if (key && requestHash) {
      const replay = await replayRequest(
        () => this.connect(),
        'geodata-candidate-validation',
        key,
        requestHash,
      );
      if (replay.found) return replay.response;
    }
    const missing = ['candidateIds', 'reviewerId'].filter(
      (field) => !pythonTruthy(body[field]),
    );
    if (missing.length)
      throw new BadRequestException(
        `missing required fields: ${missing.join(', ')}`,
      );
    const rawIds = body.candidateIds;
    if (!Array.isArray(rawIds) || !rawIds.length)
      throw new BadRequestException('candidateIds must be a non-empty list');
    if (rawIds.length > MAX_SYNCHRONOUS_IMPORT_CANDIDATES)
      throw new BadRequestException(
        `at most ${MAX_SYNCHRONOUS_IMPORT_CANDIDATES} candidates can be validated in one synchronous request`,
      );
    const candidateIds = rawIds.map(pythonString);
    const uniqueCandidateIds = [...new Set(candidateIds)];
    const reviewerId = body.reviewerId;
    const requested = pythonString(
      pythonTruthy(body.validationStatus) ? body.validationStatus : 'VALID',
    ).toUpperCase();
    if (!['VALID', 'CONFIRMED', 'REJECTED', 'INVALID'].includes(requested))
      throw new BadRequestException(
        'validationStatus must be VALID or REJECTED',
      );
    const invalidId = candidateIds.find(
      (id) => !isUuid(id) || id !== id.toLowerCase(),
    );
    if (invalidId)
      throw new BadRequestException(
        `candidate ${invalidId} does not belong to import run`,
      );
    const rejected = requested === 'REJECTED' || requested === 'INVALID';
    const note = body.note === undefined ? null : body.note;
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      if (key) {
        await lockRequest(client, key);
        const previous = await readRequestResponse(
          client,
          'geodata-candidate-validation',
          key,
          requestHash,
        );
        if (previous.found) {
          await client.query('COMMIT');
          return previous.response;
        }
      }
      const selected = await client.query(
        `SELECT id,validation_status,processing_queue_id
         FROM geodata_import_candidate WHERE import_run_id=$1 AND id=ANY($2::uuid[])
         FOR UPDATE`,
        [runId, uniqueCandidateIds],
      );
      if (selected.rows.length !== uniqueCandidateIds.length) {
        const selectedIds = new Set(selected.rows.map((row) => String(row.id)));
        const missing = candidateIds.find((id) => !selectedIds.has(id));
        throw new BadRequestException(
          `candidate ${missing} does not belong to import run`,
        );
      }
      if (rejected && selected.rows.some((row) => row.processing_queue_id))
        throw new BadRequestException('queued records cannot be rejected');

      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      if (rejected) {
        await client.query(
          'DELETE FROM geodata_import_candidate WHERE import_run_id=$1 AND id=ANY($2::uuid[])',
          [runId, uniqueCandidateIds],
        );
      } else {
        await client.query(
          `UPDATE geodata_import_candidate SET validation_status='CONFIRMED',
           validation_note=$3::jsonb,validated_by=$4,validated_at=now(),updated_at=now()
           WHERE import_run_id=$1 AND id=ANY($2::uuid[]) AND validation_status<>'PROCESSED'`,
          [
            runId,
            uniqueCandidateIds,
            stringifyJsonWithBigInts(note),
            reviewerId,
          ],
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
          stringifyJsonWithBigInts({
            importRunId: runId,
            candidateIds,
            reviewerId,
          }),
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
          [
            'geodata-candidate-validation',
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

  async processImportCandidates(
    runId: string,
    key: string | undefined,
    body: Record<string, unknown>,
    claims: AccessTokenClaims,
    requestHash?: string,
  ) {
    if (key && requestHash) {
      const replay = await replayRequest(
        () => this.connect(),
        'geodata-import-promotion',
        key,
        requestHash,
      );
      if (replay.found) return replay.response;
    }
    const missing = ['candidateIds', 'targetStatus', 'processorId'].filter(
      (field) => !pythonTruthy(body[field]),
    );
    if (missing.length)
      throw new BadRequestException(
        `missing required fields: ${missing.join(', ')}`,
      );
    const targetStatus = pythonString(body.targetStatus).toUpperCase();
    const rawIds = body.candidateIds;
    if (!Array.isArray(rawIds) || !rawIds.length)
      throw new BadRequestException('candidateIds must be a non-empty list');
    if (!['CANDIDATE', 'APPROVED'].includes(targetStatus))
      throw new BadRequestException(
        'targetStatus must be CANDIDATE or APPROVED',
      );
    const candidateIds = [...new Set(rawIds.map(pythonString))].sort(
      (left, right) => (left < right ? -1 : left > right ? 1 : 0),
    );
    if (candidateIds.length > MAX_SYNCHRONOUS_IMPORT_CANDIDATES)
      throw new BadRequestException(
        `at most ${MAX_SYNCHRONOUS_IMPORT_CANDIDATES} candidates can be promoted in one synchronous request`,
      );
    const invalidId = candidateIds.find(
      (id) => !isUuid(id) || id !== id.toLowerCase(),
    );
    if (invalidId)
      throw new BadRequestException(
        `candidate ${invalidId} does not belong to import run`,
      );
    const requestedBy = body.processorId;
    const note = body.note === undefined ? null : body.note;
    if (
      body.manualAssignments !== undefined &&
      !isRecord(body.manualAssignments)
    )
      throw new BadRequestException('manualAssignments must be an object');
    const manualAssignments = isRecord(body.manualAssignments)
      ? body.manualAssignments
      : {};
    const extraAssignmentIds = Object.keys(manualAssignments).filter(
      (id) => !candidateIds.includes(id),
    );
    if (extraAssignmentIds.length)
      throw new BadRequestException(
        `manualAssignments contains unselected candidate ${extraAssignmentIds[0]}`,
      );
    const numberingPolicies =
      await this.promotion.loadProgrammeNumberingPolicies(runId, candidateIds);
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      if (key) {
        await lockRequest(client, key);
      }
      // Worker promotion locks its queue row before candidate rows. Match that
      // lock order so retrying a failed candidate cannot deadlock the worker.
      const priorQueueRows = await client.query(
        `SELECT q.id,q.status,q.result
         FROM geodata_import_processing_queue q
         JOIN geodata_import_candidate c ON c.processing_queue_id=q.id
         WHERE c.import_run_id=$1 AND c.id=ANY($2::uuid[])
         ORDER BY q.id FOR UPDATE OF q`,
        [runId, candidateIds],
      );
      const priorQueues = new Map(
        priorQueueRows.rows.map((row) => [String(row.id), row]),
      );
      const selected = await client.query(
        `SELECT c.id,c.programme_slug,c.entity_type_codes,c.entity_payload,
          c.validation_status,c.processing_queue_id
         FROM geodata_import_candidate c
         WHERE c.import_run_id=$1 AND c.id=ANY($2::uuid[])
         ORDER BY c.id
         FOR UPDATE OF c`,
        [runId, candidateIds],
      );
      const selectedById = new Map(
        selected.rows.map((row) => [String(row.id), row]),
      );
      for (const candidateId of candidateIds) {
        const row = selectedById.get(candidateId);
        if (!row)
          throw new BadRequestException(
            `candidate ${candidateId} does not belong to import run`,
          );
        if (targetStatus === 'APPROVED') {
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
      }
      if (key) {
        const previous = await readRequestResponse(
          client,
          'geodata-import-promotion',
          key,
          requestHash,
        );
        if (previous.found) {
          await client.query('COMMIT');
          return previous.response;
        }
      }
      for (const candidateId of candidateIds) {
        const row = selectedById.get(candidateId)!;
        if (row.validation_status === 'PROCESSED')
          throw new BadRequestException('record is already promoted or queued');
        if (!row.processing_queue_id) continue;
        const prior = priorQueues.get(String(row.processing_queue_id));
        let priorResult: unknown = prior?.result;
        if (typeof priorResult === 'string') {
          try {
            priorResult = JSON.parse(priorResult);
          } catch {
            priorResult = undefined;
          }
        }
        const priorErrors = isRecord(priorResult) ? priorResult.errors : null;
        const failedThisCandidate =
          Array.isArray(priorErrors) &&
          priorErrors.some(
            (error) =>
              isRecord(error) && String(error.candidateId) === String(row.id),
          );
        if (
          row.validation_status !== 'CONFIRMED' ||
          prior?.status !== 'FAILED' ||
          !failedThisCandidate
        )
          throw new BadRequestException('record is already promoted or queued');
      }

      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await client.query(
        `UPDATE geodata_import_candidate SET validation_status='CONFIRMED',
         processing_queue_id=NULL,
         validated_by=$3,validated_at=now(),target_status=$4,updated_at=now()
         WHERE import_run_id=$1 AND id=ANY($2::uuid[])`,
        [runId, candidateIds, requestedBy, targetStatus],
      );
      const promotionQueue: PromotionQueue = {
        id: '',
        import_run_id: runId,
        candidate_ids: candidateIds,
        target_status: targetStatus as 'CANDIDATE' | 'APPROVED',
        requested_by: String(requestedBy),
        job_metadata: { note, manualAssignments },
        attempt_count: 0,
      };
      const created: string[] = [];
      const updated: string[] = [];
      for (const candidateId of candidateIds) {
        let result: { entityId: string; updated: boolean };
        try {
          result = await this.promotion.promoteCandidateInTransaction(
            client,
            promotionQueue,
            candidateId,
            numberingPolicies,
          );
        } catch (error) {
          if (isCandidateConflict(error))
            throw new BadRequestException(
              error instanceof Error ? error.message : String(error),
            );
          throw error;
        }
        (result.updated ? updated : created).push(result.entityId);
      }
      const totals = await client.query(
        `SELECT count(*) FILTER (WHERE validation_status='PROCESSED' AND existing_entity_id IS NULL) AS created,
          count(*) FILTER (WHERE validation_status='PROCESSED' AND existing_entity_id IS NOT NULL) AS updated,
          count(*) FILTER (WHERE validation_status<>'PROCESSED') AS remaining
         FROM geodata_import_candidate WHERE import_run_id=$1`,
        [runId],
      );
      const createdCount = parsePageTotal(totals.rows[0].created);
      const updatedCount = parsePageTotal(totals.rows[0].updated);
      const remainingCount = parsePageTotal(totals.rows[0].remaining);
      await client.query(
        `UPDATE import_run SET stats=stats || $2::jsonb,
         status=CASE WHEN $3::bigint=0 THEN 'COMPLETED' ELSE status END,
         completed_at=CASE WHEN $3::bigint=0 THEN COALESCE(completed_at,now()) ELSE completed_at END
         WHERE id=$1`,
        [
          runId,
          stringifyJsonWithBigInts({
            created: createdCount,
            updated: updatedCount,
            processed: parsePageTotal(
              BigInt(createdCount) + BigInt(updatedCount),
            ),
            processingErrors: 0,
          }),
          remainingCount,
        ],
      );
      const response = {
        importRunId: runId,
        candidateIds,
        targetStatus,
        requestedBy,
        status: 'COMPLETED',
        created,
        updated,
        completedAt: await utcTimestamp(client),
      };
      if (key)
        await client.query(
          'INSERT INTO idempotency_record(service,key,response) VALUES ($1,$2,$3::jsonb)',
          [
            'geodata-import-promotion',
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

  async redriveImportProcessingQueue(
    runId: string,
    queueId: string,
    key: string | undefined,
    requestedBy: string,
    reasonValue: unknown,
    requestHash?: string,
  ) {
    if (key && requestHash) {
      const replay = await replayRequest(
        () => this.connect(),
        'geodata-import-redrive',
        key,
        requestHash,
      );
      if (replay.found) return replay.response;
    }
    const reason = typeof reasonValue === 'string' ? reasonValue.trim() : '';
    if (!reason || reason.length > 1000)
      throw new BadRequestException(
        'reason is required and must be at most 1000 characters',
      );
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      if (key) {
        await lockRequest(client, key);
        const previous = await readRequestResponse(
          client,
          'geodata-import-redrive',
          key,
          requestHash,
        );
        if (previous.found) {
          await client.query('COMMIT');
          return previous.response;
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
        throw new NotFoundException(
          pythonKeyErrorDetail('import processing queue not found'),
        );
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
          requestedAt: await utcTimestamp(client),
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
        [
          queueId,
          runId,
          requestedBy,
          stringifyJsonWithBigInts(updatedMetadata),
        ],
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
        requestedAt: await utcTimestamp(client),
        redriven: true,
      };
      await client.query(
        `INSERT INTO outbox_event
         (event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
         VALUES ($1,'geodata.import.processing.queued.v1','geodata-service','import_processing_queue',$2,$3::jsonb,now(),$4)`,
        [
          randomUUID(),
          queueId,
          stringifyJsonWithBigInts({ queueId }),
          randomUUID(),
        ],
      );
      if (key)
        await client.query(
          'INSERT INTO idempotency_record(service,key,response) VALUES ($1,$2,$3::jsonb)',
          [
            'geodata-import-redrive',
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

function pythonString(value: unknown): string {
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint')
    return String(value);
  if (typeof value === 'object') return stringifyJsonWithBigInts(value);
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function publicSourceMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...metadata };
  delete result.sourceFeatureHashOverrides;
  return result;
}
