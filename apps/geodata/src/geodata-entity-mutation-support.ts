import {
  Injectable,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import { entityProjection } from './geodata.repository.js';

@Injectable()
export class GeodataEntityMutationSupport {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async writeEntityEvent(
    client: import('pg').PoolClient,
    entityId: string,
    eventType: string,
    payload: Record<string, unknown>,
    occurredAt: Date | string,
  ) {
    await client.query(
      `INSERT INTO geodata_audit_event(event_id,aggregate_type,aggregate_id,event,occurred_at)
     VALUES ($1,'entity',$2,$3::jsonb,$4)`,
      [
        randomUUID(),
        entityId,
        stringifyJsonWithBigInts({ eventType, ...payload }),
        occurredAt,
      ],
    );
    await client.query(
      `INSERT INTO outbox_event
     (event_id,event_type,producer,aggregate_type,aggregate_id,payload,occurred_at,correlation_id)
     VALUES ($1,$2,'geodata-service','entity',$3,$4::jsonb,$5,$6)`,
      [
        randomUUID(),
        eventType,
        entityId,
        stringifyJsonWithBigInts(payload),
        occurredAt,
        randomUUID(),
      ],
    );
  }

  async readEntityWithClient(client: PoolClient, id: string) {
    const result = await client.query(
      `SELECT ${entityProjection} AS entity FROM geodata_entity WHERE id=$1`,
      [id],
    );
    return result.rows[0]?.entity;
  }

  async connect(): Promise<PoolClient> {
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
