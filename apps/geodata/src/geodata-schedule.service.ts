import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { GeodataImportService } from './geodata-import.service.js';

type RefreshSchedule = {
  id: string;
  programmeSlug: string | null;
  entityType: string;
  entityTypes: string[];
  adapter: string;
  source: Record<string, unknown>;
  intervalSeconds: number;
  disappearancePolicy: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string;
  createdAt: string;
};

const adapters = new Set(['PARKSERVE_US', 'OSM', 'GOVERNMENT_GIS', 'MANUAL']);
const entityTypePattern = /^[A-Z][A-Z0-9_]{1,63}$/;

@Injectable()
export class GeodataScheduleService {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
    private readonly imports: GeodataImportService,
  ) {}

  async list(query: Record<string, unknown>) {
    const limit = boundedInteger(query.limit, 100, 1, 500);
    const offset = boundedInteger(query.offset, 0, 0, 1_000_000);
    const client = await this.connect();
    try {
      const result = await client.query(
        `SELECT payload FROM geodata_control_record
         WHERE kind='schedules' ORDER BY updated_at DESC,id
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
      const total = await client.query(
        "SELECT count(*)::integer AS total FROM geodata_control_record WHERE kind='schedules'",
      );
      return {
        items: result.rows.map((row) => row.payload),
        total: total.rows[0].total as number,
        limit,
        offset,
      };
    } finally {
      client.release();
    }
  }

  async create(key: string | undefined, body: Record<string, unknown>) {
    const schedule = prepareSchedule(body);
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      if (key) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('geodata-schedule-create:' || $1,0))",
          [key],
        );
        const prior = await client.query(
          'SELECT response FROM idempotency_record WHERE service=$1 AND key=$2',
          ['geodata-schedule-create', key],
        );
        if (prior.rows[0]) {
          await client.query('COMMIT');
          return prior.rows[0].response;
        }
      }
      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await client.query(
        `INSERT INTO geodata_control_record(kind,id,payload)
         VALUES ('schedules',$1,$2::jsonb)`,
        [schedule.id, JSON.stringify(schedule)],
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
          ['geodata-schedule-create', key, JSON.stringify(schedule)],
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
    body: Record<string, unknown>,
  ) {
    if (!Array.isArray(body.features) || body.features.length === 0)
      throw new BadRequestException('features must be a non-empty array');
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
    const run = await this.imports.create(importKey, {
      ...body,
      programmeSlug: schedule.programmeSlug,
      adapter: schedule.adapter,
      source: schedule.source,
      entityTypes: schedule.entityTypes,
      disappearancePolicy: schedule.disappearancePolicy,
    });
    const now = new Date();
    const runAt = now.toISOString();
    const nextRunAt = new Date(
      now.getTime() + schedule.intervalSeconds * 1000,
    ).toISOString();
    const update = await this.connect();
    try {
      await update.query('BEGIN');
      await update.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      const saved = await update.query(
        `UPDATE geodata_control_record
         SET payload=payload || jsonb_build_object('lastRunAt',$2::text,'nextRunAt',$3::text),updated_at=now()
         WHERE kind='schedules' AND id=$1 AND payload->>'enabled'='true'
         RETURNING payload`,
        [scheduleId, runAt, nextRunAt],
      );
      if (!saved.rows[0])
        throw new ConflictException('refresh schedule was disabled');
      await update.query('COMMIT');
      return { ...run, schedule: saved.rows[0].payload, queued: true };
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
        JSON.stringify(payload),
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
  const adapter =
    typeof body.adapter === 'string' ? body.adapter.trim().toUpperCase() : '';
  if (!adapters.has(adapter))
    throw new BadRequestException('unsupported refresh adapter');
  if (
    !body.source ||
    typeof body.source !== 'object' ||
    Array.isArray(body.source)
  )
    throw new BadRequestException('source must be an object');
  const rawTypes = body.entityTypes ?? body.entityTypeCodes ?? body.entityType;
  const entityTypes = (Array.isArray(rawTypes) ? rawTypes : [rawTypes])
    .map((value) =>
      String(value ?? '')
        .trim()
        .toUpperCase(),
    )
    .filter(Boolean);
  if (
    !entityTypes.length ||
    entityTypes.some((value) => !entityTypePattern.test(value)) ||
    new Set(entityTypes).size !== entityTypes.length
  )
    throw new BadRequestException('one or more valid entityTypes are required');
  const intervalSeconds = Number(body.intervalSeconds);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 300)
    throw new BadRequestException(
      'refresh interval must be at least 300 seconds',
    );
  const disappearancePolicy =
    typeof body.disappearancePolicy === 'string'
      ? body.disappearancePolicy.toUpperCase()
      : 'REVIEW_REQUIRED';
  if (
    !['UNCHANGED', 'STALE', 'RETIRED', 'REVIEW_REQUIRED'].includes(
      disappearancePolicy,
    )
  )
    throw new BadRequestException('unsupported disappearancePolicy');
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
    enabled: body.enabled !== false,
    lastRunAt: null,
    nextRunAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
}

function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : Number.NaN;
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}
