import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { parseJsonWithExactIntegers } from '@app/platform/json-exact.js';
import {
  verifyAccessToken,
  type AccessTokenClaims,
} from '@app/platform/access-token.js';
import { pythonKeyErrorDetail } from '@app/platform/python-strings.js';
import {
  lockRequest,
  readRequestResponse,
  replayRequest,
  requestResponse,
} from './geodata-request-idempotency.js';
import { pythonTruthy } from '@app/platform/python-truthiness.js';

@Injectable()
export class GeodataDeletionService {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async create(
    authorization: string | undefined,
    key: string | undefined,
    body: Record<string, unknown>,
    requestHash?: string,
  ) {
    const claims = verifyAccessToken(authorization);
    if (key && requestHash) {
      const replay = await replayRequest(
        () => this.connect(),
        'geodata-entity-deletion',
        key,
        requestHash,
      );
      if (replay.found) return replay.response;
    }
    const entityId = typeof body.entityId === 'string' ? body.entityId : '';
    const requestedBy = body.requestedBy;
    if (!entityId || !pythonTruthy(requestedBy))
      throw new BadRequestException('entityId and requestedBy are required');
    const client = await this.connect();
    let entity: Record<string, unknown>;
    try {
      const result = await client.query(
        'SELECT id::text,lifecycle_status,programme_slug,jurisdiction FROM geodata_entity WHERE id=$1',
        [entityId],
      );
      entity = result.rows[0];
      if (!entity) throw new NotFoundException(pythonKeyErrorDetail(entityId));
    } finally {
      client.release();
    }
    authorizeDelete(claims, entity);
    if (!hasGlobalRole(claims) && entity.lifecycle_status !== 'REJECTED')
      throw new ForbiddenException(
        'only global administrators can delete non-rejected entities',
      );
    const impact = await this.activityImpact(authorization as string, entityId);
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const job = {
      id,
      entityId,
      status: 'AWAITING_CONFIRMATION',
      requestedBy,
      impact,
      confirmationRequired: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      entityContext: {
        programmeSlug: entity.programme_slug,
        jurisdiction: entity.jurisdiction,
      },
      executionClaims: {
        sub: claims.sub,
        scp: claims.scp,
        roles: claims.roles ?? [],
      },
    };
    const response = publicJob(job);
    const transaction = await this.connect();
    try {
      await transaction.query('BEGIN');
      if (key) {
        await lockRequest(transaction, key);
        const existing = await readRequestResponse(
          transaction,
          'geodata-entity-deletion',
          key,
          requestHash,
        );
        if (existing.found) {
          await transaction.query('COMMIT');
          return existing.response;
        }
      }
      await transaction.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await transaction.query(
        `INSERT INTO geodata_control_record(kind,id,payload)
         VALUES ('entityDeletionJobs',$1,$2::jsonb)`,
        [id, stringifyJsonWithBigInts(job)],
      );
      await this.outbox(
        transaction,
        'geodata.entity-deletion-job.created.v1',
        id,
        response,
      );
      if (key)
        await transaction.query(
          'INSERT INTO idempotency_record(service,key,response) VALUES ($1,$2,$3::jsonb)',
          [
            'geodata-entity-deletion',
            key,
            stringifyJsonWithBigInts(requestResponse(response, requestHash)),
          ],
        );
      await transaction.query('COMMIT');
      return response;
    } catch (error) {
      await transaction.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      transaction.release();
    }
  }

  async get(authorization: string | undefined, jobId: string) {
    const claims = verifyAccessToken(authorization);
    const client = await this.connect();
    try {
      const result = await client.query(
        "SELECT payload FROM geodata_control_record WHERE kind='entityDeletionJobs' AND id=$1",
        [jobId],
      );
      const job = result.rows[0]?.payload as
        Record<string, unknown> | undefined;
      if (!job) throw new NotFoundException(pythonKeyErrorDetail(jobId));
      const entity = {
        programme_slug: (job.entityContext as Record<string, unknown>)
          ?.programmeSlug,
        jurisdiction: (job.entityContext as Record<string, unknown>)
          ?.jurisdiction,
      };
      authorizeDelete(claims, entity);
      return publicJob(job);
    } finally {
      client.release();
    }
  }

  async confirm(
    authorization: string | undefined,
    key: string | undefined,
    jobId: string,
    body: Record<string, unknown>,
    requestHash?: string,
  ) {
    const claims = verifyAccessToken(authorization);
    if (key && requestHash) {
      const replay = await replayRequest(
        () => this.connect(),
        'geodata-entity-deletion-confirm',
        key,
        requestHash,
      );
      if (replay.found) return replay.response;
    }
    const confirmation =
      typeof body.confirmation === 'string'
        ? body.confirmation.toUpperCase()
        : '';
    const deletedBy = body.deletedBy;
    if (confirmation !== 'DELETE' || !pythonTruthy(deletedBy))
      throw new BadRequestException(
        'confirmation must be DELETE and deletedBy is required',
      );
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      if (key) {
        await lockRequest(client, key);
        const prior = await readRequestResponse(
          client,
          'geodata-entity-deletion-confirm',
          key,
          requestHash,
        );
        if (prior.found) {
          await client.query('COMMIT');
          return prior.response;
        }
      }
      const selected = await client.query(
        `SELECT payload FROM geodata_control_record
         WHERE kind='entityDeletionJobs' AND id=$1 FOR UPDATE`,
        [jobId],
      );
      const job = selected.rows[0]?.payload as
        Record<string, unknown> | undefined;
      if (!job) throw new NotFoundException(pythonKeyErrorDetail(jobId));
      authorizeDelete(claims, {
        programme_slug: (job.entityContext as Record<string, unknown>)
          ?.programmeSlug,
        jurisdiction: (job.entityContext as Record<string, unknown>)
          ?.jurisdiction,
      });
      if (job.status === 'COMPLETED') {
        const response = publicJob(job);
        if (key)
          await client.query(
            'INSERT INTO idempotency_record(service,key,response) VALUES ($1,$2,$3::jsonb)',
            [
              'geodata-entity-deletion-confirm',
              key,
              stringifyJsonWithBigInts(requestResponse(response, requestHash)),
            ],
          );
        await client.query('COMMIT');
        return response;
      }
      if (job.status !== 'AWAITING_CONFIRMATION')
        throw new ConflictException(
          'deletion job is not awaiting confirmation',
        );
      if (!claims.scp.includes('*') && !claims.scp.includes('activity.admin'))
        throw new ForbiddenException(
          'activity.admin scope is required to confirm entity deletion',
        );
      const updated = {
        ...job,
        status: 'QUEUED',
        confirmedBy: deletedBy,
        confirmedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        executionClaims: {
          sub: claims.sub,
          scp: claims.scp,
          roles: claims.roles ?? [],
        },
      };
      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await client.query(
        `UPDATE geodata_control_record SET payload=$2::jsonb,updated_at=now()
         WHERE kind='entityDeletionJobs' AND id=$1`,
        [jobId, stringifyJsonWithBigInts(updated)],
      );
      await this.outbox(
        client,
        'geodata.entity-deletion-job.queued.v1',
        jobId,
        { jobId, natsSubject: 'myota.geodata.entity.delete.v1' },
      );
      const response = { ...publicJob(updated), queued: true };
      if (key)
        await client.query(
          'INSERT INTO idempotency_record(service,key,response) VALUES ($1,$2,$3::jsonb)',
          [
            'geodata-entity-deletion-confirm',
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

  private async activityImpact(authorization: string, entityId: string) {
    const base = (
      process.env.MYOTA_ACTIVITY_URL ?? 'http://activity:8004'
    ).replace(/\/+$/, '');
    const url = `${base}/v1/activations/entity-deletion-impacts/${encodeURIComponent(entityId)}`;
    try {
      const response = await fetch(url, {
        headers: { authorization, accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 401 || response.status === 403)
        throw new ForbiddenException(
          'activity.admin scope is required to inspect deletion impact',
        );
      if (!response.ok)
        throw new Error(`Activity returned HTTP ${response.status}`);
      const impact = parseJsonWithExactIntegers(await response.text());
      if (!isRecord(impact))
        throw new Error('Activity impact was not an object');
      return impact;
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new ServiceUnavailableException(
        'Activity deletion impact is unavailable',
      );
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
       VALUES ($1,$2,'geodata-service','entity_deletion_job',$3,$4::jsonb,now(),$5)`,
      [
        randomUUID(),
        eventType,
        aggregateId,
        stringifyJsonWithBigInts(payload),
        randomUUID(),
      ],
    );
  }

  private async connect() {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function authorizeDelete(
  claims: AccessTokenClaims,
  entity: Record<string, unknown>,
) {
  if (claims.scp.includes('*') || claims.scp.includes('geodata.delete')) return;
  const roles = claims.roles ?? [];
  const allowed = roles.some((role) => {
    if (!['GIS_ADMIN', 'GLOBAL_OPERATOR'].includes(String(role.role)))
      return false;
    if (
      typeof role.programmeSlug === 'string' &&
      role.programmeSlug !== entity.programme_slug
    )
      return false;
    return !(
      typeof role.jurisdiction === 'string' &&
      role.jurisdiction !== entity.jurisdiction
    );
  });
  if (!allowed)
    throw new ForbiddenException(
      'global or GIS administrator access is required',
    );
}

function hasGlobalRole(claims: AccessTokenClaims) {
  return (
    claims.roles?.some((role) =>
      ['GLOBAL_ADMIN', 'GLOBAL_OPERATOR'].includes(String(role.role)),
    ) ?? false
  );
}

function publicJob(job: Record<string, unknown>) {
  const {
    executionClaims: _executionClaims,
    entityContext: _context,
    ...result
  } = job;
  return result;
}
