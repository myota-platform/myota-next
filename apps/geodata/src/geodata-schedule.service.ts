import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  firstPythonTruthy,
  normalizeEntityTypeCodes,
} from './geodata-entity-types.js';
import { normalizePythonNumericText } from '@app/platform/python-numeric.js';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { parsePageInteger } from '@app/platform/pagination.js';
import { GeodataImportService } from './geodata-import.service.js';
import {
  lockRequest,
  readRequestResponse,
  replayRequest,
  requestResponse,
} from './geodata-request-idempotency.js';

type RefreshSchedule = {
  id: string;
  programmeSlug: string | null;
  entityType: string;
  entityTypes: string[];
  adapter: string;
  source: Record<string, unknown>;
  intervalSeconds: number;
  disappearancePolicy: unknown;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string;
  createdAt: string;
};

const adapters = new Set(['PARKSERVE_US', 'OSM', 'GOVERNMENT_GIS', 'MANUAL']);

@Injectable()
export class GeodataScheduleService {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
    private readonly imports: GeodataImportService,
  ) {}

  async list(query: Record<string, unknown>) {
    const page = parsePageInteger(query.page, 1);
    const pageSize = parsePageInteger(query.pageSize, 50, 100);
    const offset = BigInt(page - 1) * BigInt(pageSize);
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT payload FROM geodata_control_record
         WHERE kind='schedules' ORDER BY payload->>'createdAt' ASC NULLS LAST,id
         LIMIT $1 OFFSET $2::bigint`,
        [pageSize, offset.toString()],
      );
      const total = await client.query(
        "SELECT count(*)::integer AS total FROM geodata_control_record WHERE kind='schedules'",
      );
      const totalCount = total.rows[0].total as number;
      return {
        items: result.rows.map((row) => row.payload),
        page,
        pageSize,
        total: totalCount,
        nextPage:
          offset + BigInt(pageSize) < BigInt(totalCount) ? page + 1 : null,
      };
    } finally {
      client.release();
    }
  }

  async create(
    key: string | undefined,
    body: Record<string, unknown>,
    requestHash?: string,
  ) {
    if (key && requestHash) {
      const replay = await replayRequest(
        () => this.connect(),
        'geodata-schedule-create',
        key,
        requestHash,
      );
      if (replay.found) return replay.response;
    }
    const schedule = prepareSchedule(body);
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      if (key) {
        await lockRequest(client, key);
        const prior = await readRequestResponse(
          client,
          'geodata-schedule-create',
          key,
          requestHash,
        );
        if (prior.found) {
          await client.query('COMMIT');
          return prior.response;
        }
      }
      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await client.query(
        `INSERT INTO geodata_control_record(kind,id,payload)
         VALUES ('schedules',$1,$2::jsonb)`,
        [schedule.id, stringifyJsonWithBigInts(schedule)],
      );
      await this.outbox(
        client,
        'geodata.refresh-schedule.created.v1',
        schedule.id,
        schedule,
      );
      if (key)
        await client.query(
          'INSERT INTO idempotency_record(service,key,response) VALUES ($1,$2,$3::jsonb)',
          [
            'geodata-schedule-create',
            key,
            stringifyJsonWithBigInts(requestResponse(schedule, requestHash)),
          ],
        );
      await client.query('COMMIT');
      return schedule;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async run(
    key: string | undefined,
    scheduleId: string,
    requestedBy: string,
    body: Record<string, unknown>,
    requestHash?: string,
  ) {
    if (key && requestHash) {
      const replay = await replayRequest(
        () => this.connect(),
        'geodata-schedule-run',
        key,
        requestHash,
      );
      if (replay.found) return replay.response;
    }
    if (!Array.isArray(body.features))
      throw new BadRequestException('features must be an array');
    const client = await this.connect();
    let schedule: RefreshSchedule;
    try {
      const result = await client.query(
        `SELECT payload FROM geodata_control_record
         WHERE kind='schedules' AND id=$1`,
        [scheduleId],
      );
      schedule = result.rows[0]?.payload as RefreshSchedule;
      if (!schedule) throw new NotFoundException('refresh schedule not found');
      if (!schedule.enabled)
        throw new ConflictException('refresh schedule is disabled');
    } finally {
      client.release();
    }

    const importKey = key
      ? `schedule:${scheduleId}:${key}`
      : `schedule:${scheduleId}:${randomUUID()}`;
    const hashOverrides = body.sourceFeatureHashOverrides;
    const sourceFeatureHashOverrides =
      requestedBy === 'service:geodata-importer' &&
      Array.isArray(hashOverrides) &&
      hashOverrides.length === body.features.length &&
      hashOverrides.every(
        (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value),
      )
        ? (hashOverrides as string[])
        : undefined;
    const run = (await this.imports.create(
      importKey,
      {
        ...body,
        programmeSlug: schedule.programmeSlug,
        adapter: schedule.adapter,
        source: schedule.source,
        entityTypes: schedule.entityTypes,
        disappearancePolicy: schedule.disappearancePolicy,
        completeSnapshot: true,
      },
      {
        autoPromote: { requestedBy, note: 'Scheduled source refresh' },
        requestHash,
        sourceFeatureHashOverrides,
      },
    )) as Record<string, unknown>;
    const now = new Date();
    const runAt = now.toISOString();
    const update = await this.connect();
    try {
      await update.query('BEGIN');
      if (key) {
        await lockRequest(update, key);
        const previous = await readRequestResponse(
          update,
          'geodata-schedule-run',
          key,
          requestHash,
        );
        if (previous.found) {
          await update.query('COMMIT');
          return previous.response;
        }
      }
      await update.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      const saved = await update.query(
        `UPDATE geodata_control_record
         SET payload=payload || jsonb_build_object('lastRunAt',$2::text,'nextRunAt',$2::text),updated_at=now()
         WHERE kind='schedules' AND id=$1 AND payload->>'enabled'='true'
         RETURNING payload`,
        [scheduleId, runAt],
      );
      if (!saved.rows[0])
        throw new ConflictException('refresh schedule was disabled');
      const response = {
        ...run,
        schedule: saved.rows[0].payload,
        queued: true,
      };
      if (key)
        await update.query(
          'INSERT INTO idempotency_record(service,key,response) VALUES ($1,$2,$3::jsonb)',
          [
            'geodata-schedule-run',
            key,
            stringifyJsonWithBigInts(requestResponse(response, requestHash)),
          ],
        );
      await update.query('COMMIT');
      return response;
    } catch (error) {
      await update.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      update.release();
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
       VALUES ($1,$2,'geodata-service','refresh_schedule',$3,$4::jsonb,now(),$5)`,
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

function prepareSchedule(body: Record<string, unknown>): RefreshSchedule {
  const adapter = typeof body.adapter === 'string' ? body.adapter : '';
  if (!adapters.has(adapter))
    throw new BadRequestException('unsupported refresh adapter');
  if (
    !body.source ||
    typeof body.source !== 'object' ||
    Array.isArray(body.source)
  )
    throw new BadRequestException('source must be an object');
  const entityTypes = normalizeEntityTypeCodes(
    firstPythonTruthy(body.entityTypes, body.entityTypeCodes),
    body.entityType,
  );
  if (!entityTypes.length)
    throw new BadRequestException(
      'entityTypes must contain at least one shared entity category code',
    );
  const intervalSeconds = referenceInteger(body.intervalSeconds);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 300)
    throw new BadRequestException(
      'refresh interval must be at least 300 seconds',
    );
  const disappearancePolicy =
    body.disappearancePolicy === undefined
      ? 'REVIEW_REQUIRED'
      : body.disappearancePolicy;
  return {
    id: randomUUID(),
    programmeSlug:
      typeof body.programmeSlug === 'string' ? body.programmeSlug : null,
    entityType: entityTypes[0],
    entityTypes,
    adapter,
    source: body.source as Record<string, unknown>,
    intervalSeconds,
    disappearancePolicy,
    enabled: body.enabled === undefined ? true : referenceTruthy(body.enabled),
    lastRunAt: null,
    nextRunAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
}

function referenceTruthy(value: unknown): boolean {
  if (value == null || value === false) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function referenceInteger(value: unknown): number {
  if (typeof value === 'number') return Math.trunc(value);
  if (typeof value === 'boolean') return Number(value);
  if (typeof value !== 'string') return Number.NaN;
  const normalized = normalizePythonNumericText(value);
  if (!/^[+-]?\d(?:_?\d)*$/.test(normalized)) return Number.NaN;
  return Number(normalized.replaceAll('_', ''));
}
