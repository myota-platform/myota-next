import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import {
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { signAccessToken } from '@app/platform/access-token.js';
import { utcTimestamp } from '@app/platform/utc-timestamp.js';

type DeletionJob = Record<string, any> & {
  id: string;
  entityId: string;
  status: string;
  requestedBy: unknown;
  executionClaims: {
    sub: string;
    scp: string[];
    roles?: Record<string, unknown>[];
  };
};

@Injectable()
export class GeodataDeletionRepository {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async claim(jobId?: string): Promise<DeletionJob | null> {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT id,payload FROM geodata_control_record
         WHERE kind='entityDeletionJobs' AND ($1::uuid IS NULL OR id=$1) AND
           (payload->>'status'='QUEUED' OR
            (payload->>'status'='PROCESSING' AND
             (payload->>'leaseUntil')::timestamptz<=now()))
         ORDER BY updated_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,
        [jobId ?? null],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return null;
      }
      const job = row.payload as DeletionJob;
      const leaseResult = await client.query<{ lease_until: string }>(
        `SELECT jsonb_build_object(
           'leaseUntil',now()+interval '120 seconds'
         )->>'leaseUntil' AS lease_until`,
      );
      const claimed = {
        ...job,
        status: 'PROCESSING',
        leaseUntil: leaseResult.rows[0].lease_until,
        updatedAt: await utcTimestamp(client),
      };
      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await client.query(
        `UPDATE geodata_control_record SET payload=$2::jsonb,updated_at=now()
         WHERE kind='entityDeletionJobs' AND id=$1`,
        [row.id, stringifyJsonWithBigInts(claimed)],
      );
      await client.query('COMMIT');
      return claimed;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getDeletionState(jobId: string): Promise<{
    status: string;
    leaseRemainingSeconds: number;
  } | null> {
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT payload->>'status' AS status,
          GREATEST(0,EXTRACT(EPOCH FROM ((payload->>'leaseUntil')::timestamptz-now()))) AS lease_remaining
         FROM geodata_control_record WHERE kind='entityDeletionJobs' AND id=$1`,
        [jobId],
      );
      const row = result.rows[0];
      return row
        ? {
            status: row.status,
            leaseRemainingSeconds: Number(row.lease_remaining ?? 0),
          }
        : null;
    } finally {
      client.release();
    }
  }

  async heartbeat(job: DeletionJob): Promise<boolean> {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      const result = await client.query(
        `UPDATE geodata_control_record SET payload=payload || jsonb_build_object(
           'leaseUntil',now()+interval '120 seconds','updatedAt',now()),updated_at=now()
         WHERE kind='entityDeletionJobs' AND id=$1 AND payload->>'status'='PROCESSING'
           AND payload->>'leaseUntil'=$2
         RETURNING payload->>'leaseUntil' AS lease_until`,
        [job.id, job.leaseUntil],
      );
      await client.query('COMMIT');
      if (result.rows[0]) job.leaseUntil = result.rows[0].lease_until;
      return Boolean(result.rowCount);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async execute(job: DeletionJob) {
    try {
      const entity = await this.getEntity(job.entityId);
      const previousStatus = entity?.lifecycle_status ?? 'DELETED';
      if (
        !hasGlobalRole(job.executionClaims.roles) &&
        previousStatus !== 'REJECTED' &&
        previousStatus !== 'DELETED'
      )
        throw new ConflictException(
          'only global administrators can delete non-rejected entities',
        );
      const cascade = await this.activityCascade(job);
      await this.complete(job, cascade, previousStatus);
      return true;
    } catch (error) {
      await this.retry(job, error);
      return false;
    }
  }

  private async getEntity(id: string) {
    const client = await this.connect();
    try {
      const result = await client.query(
        'SELECT lifecycle_status FROM geodata_entity WHERE id=$1',
        [id],
      );
      return result.rows[0] as { lifecycle_status: string } | undefined;
    } finally {
      client.release();
    }
  }

  private async activityCascade(job: DeletionJob) {
    const base = (
      process.env.MYOTA_ACTIVITY_URL ?? 'http://activity:8004'
    ).replace(/\/+$/, '');
    const token = signAccessToken(
      job.executionClaims.sub,
      job.executionClaims.scp,
      job.executionClaims.roles ?? [],
      300,
    );
    const response = await fetch(
      `${base}/v1/activations/entity-deletion-cascades`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': `geodata-delete:${job.id}`,
        },
        body: stringifyJsonWithBigInts({
          entityId: job.entityId,
          deletedBy: job.confirmedBy ?? job.requestedBy,
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok)
      throw new Error(
        `Activity deletion cascade returned HTTP ${response.status}`,
      );
    return (await response.json()) as Record<string, unknown>;
  }

  private async complete(
    job: DeletionJob,
    cascade: Record<string, unknown>,
    previousStatus: string,
  ) {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT payload FROM geodata_control_record
         WHERE kind='entityDeletionJobs' AND id=$1 FOR UPDATE`,
        [job.id],
      );
      const current = result.rows[0]?.payload as DeletionJob | undefined;
      if (!current) throw new ConflictException('deletion job disappeared');
      if (current.status === 'COMPLETED') {
        await client.query('COMMIT');
        return;
      }
      if (current.status !== 'PROCESSING')
        throw new ConflictException('deletion job is no longer leased');
      const deletedAt = await utcTimestamp(client);
      const deleted = {
        entityId: job.entityId,
        deleted: true,
        previousStatus,
      };
      const completed = {
        ...current,
        status: 'COMPLETED',
        cascade,
        deleted,
        completedAt: deletedAt,
        updatedAt: deletedAt,
        leaseUntil: null,
      };
      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await client.query(
        'DELETE FROM conflation_candidate WHERE left_entity_id=$1 OR right_entity_id=$1 OR survivor_entity_id=$1',
        [job.entityId],
      );
      await client.query(
        'DELETE FROM geodata_edit_staging WHERE entity_id=$1',
        [job.entityId],
      );
      await client.query('DELETE FROM entity_review WHERE entity_id=$1', [
        job.entityId,
      ]);
      await client.query(
        'DELETE FROM geodata_entity_category WHERE entity_id=$1',
        [job.entityId],
      );
      await client.query('DELETE FROM source_reference WHERE entity_id=$1', [
        job.entityId,
      ]);
      await client.query('DELETE FROM geodata_entity WHERE id=$1', [
        job.entityId,
      ]);
      const event = {
        eventType: 'geodata.entity.deleted.v1',
        entityId: job.entityId,
        deletedBy: current.confirmedBy ?? job.requestedBy,
        previousStatus,
      };
      await client.query(
        `INSERT INTO geodata_audit_event(event_id,aggregate_type,aggregate_id,event,occurred_at)
         VALUES ($1,'entity',$2,$3::jsonb,$4)`,
        [
          randomUUID(),
          job.entityId,
          stringifyJsonWithBigInts(event),
          deletedAt,
        ],
      );
      await client.query(
        `UPDATE geodata_control_record SET payload=$2::jsonb,updated_at=now()
         WHERE kind='entityDeletionJobs' AND id=$1`,
        [job.id, stringifyJsonWithBigInts(completed)],
      );
      await this.outbox(
        client,
        'geodata.entity.deleted.v1',
        job.entityId,
        event,
      );
      await this.outbox(
        client,
        'geodata.entity-deletion-job.completed.v1',
        job.id,
        publicJob(completed),
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async retry(job: DeletionJob, error: unknown) {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await client.query(
        `UPDATE geodata_control_record
         SET payload=payload || jsonb_build_object(
           'status','PROCESSING','leaseUntil',now()+interval '5 seconds',
           'lastError',$2,'updatedAt',now()),updated_at=now()
         WHERE kind='entityDeletionJobs' AND id=$1 AND payload->>'status'='PROCESSING'`,
        [
          job.id,
          error instanceof Error ? error.message.slice(0, 2000) : String(error),
        ],
      );
      await client.query('COMMIT');
    } catch (failure) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw failure;
    } finally {
      client.release();
    }
  }

  private async outbox(
    client: PoolClient,
    eventType: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ) {
    await client.query(
      `INSERT INTO outbox_event
       (event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
       VALUES ($1,$2,'geodata-worker','entity_deletion_job',$3,$4::jsonb,now(),$5)`,
      [
        randomUUID(),
        eventType,
        aggregateId,
        stringifyJsonWithBigInts(payload),
        randomUUID(),
      ],
    );
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

function hasGlobalRole(roles: Record<string, unknown>[] | undefined) {
  return (
    roles?.some((role) =>
      ['GLOBAL_ADMIN', 'GLOBAL_OPERATOR'].includes(String(role.role)),
    ) ?? false
  );
}

function publicJob(job: DeletionJob) {
  const { executionClaims: _claims, entityContext: _context, ...result } = job;
  return result;
}
