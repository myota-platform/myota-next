import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  DATABASE_HEALTH_POOL,
  verifyAccessToken,
} from '@app/platform/index.js';
import type {
  CreateProgrammeDto,
  UpdateProgrammeDto,
} from './programmes.dto.js';

interface ProgrammeRecord {
  id: string;
  slug: string;
  name: string;
  description?: string;
  entityTypeCodes?: string[];
  rules: unknown;
  entityTypes: unknown[];
  policyVersion?: number;
  updatedAt?: string;
  [key: string]: unknown;
}

interface ProgrammeState {
  items?: Record<string, ProgrammeRecord>;
  events?: Record<string, unknown>[];
  data?: Record<string, unknown>;
}

@Injectable()
export class ProgrammesService {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async list(query: { page?: string; pageSize?: string }) {
    const page = parsePage(query.page, 1);
    const pageSize = Math.min(100, parsePage(query.pageSize, 50));
    const state = await this.loadState();
    const records = Object.values(state.items ?? {});
    const total = records.length;
    const start = (page - 1) * pageSize;
    return {
      items: records.slice(start, start + pageSize),
      page,
      pageSize,
      total,
      nextPage: start + pageSize < total ? page + 1 : null,
    };
  }

  async get(slug: string): Promise<ProgrammeRecord> {
    const state = await this.loadState();
    const programme = state.items?.[slug];
    if (!programme) throw new NotFoundException('programme not found');
    return programme;
  }

  async getPolicy(slug: string): Promise<Record<string, unknown>> {
    const programme = await this.get(slug);
    return {
      programmeSlug: programme.slug,
      version: programme.policyVersion ?? 1,
      rules: programme.rules,
      entityTypes: programme.entityTypes,
      updatedAt: programme.updatedAt,
    };
  }

  async create(
    authorization: string | undefined,
    body: CreateProgrammeDto,
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    const slug = body.slug.toLowerCase();
    if (!slug) throw new BadRequestException('programme slug is required');
    this.authorizeAdmin(authorization, slug);
    return this.mutateState(idempotencyKey, async (client, state) => {
      if (state.items?.[slug]) {
        throw new BadRequestException('programme slug already exists');
      }
      state.items ??= {};
      state.data ??= {};
      const catalog = entityCatalog(state);
      const normalizedTypes = body.entityTypes.map((entityType) =>
        normalizeEntityType(entityType),
      );
      for (const entityType of normalizedTypes) {
        catalog[entityType.code] ??= entityType;
      }
      const entityTypeCodes = [
        ...new Set(normalizedTypes.map((item) => item.code)),
      ];
      const entityTypes = entityTypeCodes.map((code) => catalog[code]);
      const now = new Date().toISOString();
      const programme: ProgrammeRecord = {
        id: randomUUID(),
        slug,
        name: body.name,
        description: body.description ?? '',
        entityTypeCodes,
        entityTypes,
        rules: body.rules,
        policyVersion: body.policyVersion ?? 1,
        theme: body.theme ?? { primary: '#0f766e', accent: '#f59e0b' },
        oidc: body.oidc ?? null,
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      };
      state.items[slug] = programme;
      await this.recordEvent(
        client,
        state,
        'programme.created.v1',
        'programme',
        programme.id,
        programme,
      );
      return programme;
    });
  }

  async update(
    authorization: string | undefined,
    slug: string,
    body: UpdateProgrammeDto,
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    this.authorizeAdmin(authorization, slug);
    const status = body.status;
    if (status !== undefined && status !== 'ACTIVE' && status !== 'ARCHIVED') {
      throw new BadRequestException('status must be ACTIVE or ARCHIVED');
    }
    return this.mutateState(idempotencyKey, async (client, state) => {
      const programme = state.items?.[slug];
      if (!programme) throw new NotFoundException('programme not found');
      if (body.name !== undefined) programme.name = body.name;
      if (body.description !== undefined)
        programme.description = body.description;
      if (body.rules !== undefined) programme.rules = body.rules;
      if (body.theme !== undefined) programme.theme = body.theme;
      if (body.oidc !== undefined) programme.oidc = body.oidc;
      if (body.entityTypes !== undefined) {
        const catalog = entityCatalog(state);
        const codes: string[] = [];
        for (const item of body.entityTypes) {
          const code =
            typeof item.code === 'string' ? item.code.trim().toUpperCase() : '';
          const normalized = normalizeEntityType(item, catalog[code]);
          catalog[code] ??= normalized;
          codes.push(code);
        }
        programme.entityTypeCodes = [...new Set(codes)];
        programme.entityTypes = programme.entityTypeCodes.map(
          (code) => catalog[code],
        );
      }
      if (body.rules !== undefined || body.entityTypes !== undefined) {
        programme.policyVersion = (programme.policyVersion ?? 1) + 1;
      }
      if (status === 'ARCHIVED') programme.status = 'ARCHIVED';
      programme.updatedAt = new Date().toISOString();
      await this.recordEvent(
        client,
        state,
        status === 'ARCHIVED'
          ? 'programme.archived.v1'
          : 'programme.updated.v1',
        'programme',
        programme.id,
        status === 'ARCHIVED' ? { slug } : programme,
      );
      return programme;
    });
  }

  private async loadState(): Promise<ProgrammeState> {
    const client = await this.connect();
    try {
      const result = await client.query<{ state: ProgrammeState }>(
        "SELECT state FROM public.service_state WHERE service = 'programmes'",
      );
      return result.rows[0]?.state ?? { items: {} };
    } finally {
      client.release();
    }
  }

  private authorizeAdmin(authorization: string | undefined, slug?: string) {
    const claims = verifyAccessToken(authorization);
    const scopes = new Set(claims.scp);
    if (
      scopes.has('*') ||
      scopes.has('programme.admin') ||
      (slug !== undefined && scopes.has(`programme:${slug}:programme_admin`))
    ) {
      return;
    }
    throw new ForbiddenException('programme administration scope is required');
  }

  private async mutateState<T>(
    idempotencyKey: string | undefined,
    mutate: (client: PoolClient, state: ProgrammeState) => Promise<T>,
  ): Promise<T> {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      if (idempotencyKey) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('programmes:' || $1, 0))",
          [idempotencyKey],
        );
        const previous = await client.query<{ response: T }>(
          `SELECT response FROM public.idempotency_record
            WHERE service = 'programmes' AND key = $1`,
          [idempotencyKey],
        );
        if (previous.rows[0]) {
          await client.query('COMMIT');
          return previous.rows[0].response;
        }
      }
      const initialState = { items: {}, events: [], data: {} };
      await client.query(
        `INSERT INTO public.service_state (service, state)
         VALUES ('programmes', $1::jsonb)
         ON CONFLICT (service) DO NOTHING`,
        [JSON.stringify(initialState)],
      );
      const result = await client.query<{ state: ProgrammeState }>(
        "SELECT state FROM public.service_state WHERE service = 'programmes' FOR UPDATE",
      );
      const state = result.rows[0]?.state ?? initialState;
      const response = await mutate(client, state);
      await client.query(
        `UPDATE public.service_state SET state = $1::jsonb, updated_at = now()
          WHERE service = 'programmes'`,
        [JSON.stringify(state)],
      );
      if (idempotencyKey) {
        await client.query(
          `INSERT INTO public.idempotency_record (service, key, response)
           VALUES ('programmes', $1, $2::jsonb)`,
          [idempotencyKey, JSON.stringify(response)],
        );
      }
      await client.query('COMMIT');
      return response;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async recordEvent(
    client: PoolClient,
    state: ProgrammeState,
    eventType: string,
    aggregateType: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ) {
    const event = {
      eventId: randomUUID(),
      eventType,
      occurredAt: new Date().toISOString(),
      producer: 'programmes',
      aggregate: { type: aggregateType, id: aggregateId },
      correlationId: randomUUID(),
      payload,
    };
    state.events ??= [];
    state.events.push(event);
    await client.query(
      `INSERT INTO public.outbox_event
         (event_id, event_type, producer, aggregate_type, aggregate_id,
          payload, occurred_at, correlation_id)
       VALUES ($1, $2, 'programmes', $3, $4, $5::jsonb, $6, $7)`,
      [
        event.eventId,
        event.eventType,
        aggregateType,
        aggregateId,
        JSON.stringify(payload),
        event.occurredAt,
        event.correlationId,
      ],
    );
  }

  private async connect(): Promise<PoolClient> {
    if (!this.pool) {
      throw new ServiceUnavailableException(
        'Programme database is not configured',
      );
    }
    try {
      return await this.pool.connect();
    } catch {
      throw new ServiceUnavailableException(
        'Programme database is unavailable',
      );
    }
  }
}

function entityCatalog(
  state: ProgrammeState,
): Record<string, Record<string, unknown>> {
  state.data ??= {};
  const existing = state.data.entityTypeCatalog;
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    return existing as Record<string, Record<string, unknown>>;
  }
  const catalog: Record<string, Record<string, unknown>> = {};
  state.data.entityTypeCatalog = catalog;
  return catalog;
}

const GEOMETRY_TYPES = new Set([
  'POINT',
  'LINESTRING',
  'MULTILINESTRING',
  'POLYGON',
  'MULTIPOLYGON',
]);

function normalizeEntityType(
  body: Record<string, unknown>,
  existing?: Record<string, unknown>,
): Record<string, unknown> & { code: string } {
  const code =
    typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
  const originalCode =
    typeof body.originalCode === 'string'
      ? body.originalCode.trim().toUpperCase()
      : code;
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(code)) {
    throw new BadRequestException(
      'category code must start with a letter and contain only A-Z, 0-9, and underscores',
    );
  }
  if (code !== originalCode) {
    throw new BadRequestException(
      'category codes are stable identifiers and cannot be renamed',
    );
  }
  const rawGeometry = body.geometryTypes ?? body.geometry;
  const geometryList = Array.isArray(rawGeometry)
    ? rawGeometry
    : typeof rawGeometry === 'string'
      ? [rawGeometry]
      : [];
  const geometryTypes = [
    ...new Set(
      geometryList.map((value) => {
        const geometry =
          typeof value === 'string' ? value.trim().toUpperCase() : '';
        return geometry === 'WAY' ? 'LINESTRING' : geometry;
      }),
    ),
  ];
  if (
    !geometryTypes.length ||
    geometryTypes.some((item) => !GEOMETRY_TYPES.has(item))
  ) {
    throw new BadRequestException(
      'geometryTypes must contain supported GeoJSON geometry types',
    );
  }
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (!label) throw new BadRequestException('category label must not be empty');
  const now = new Date().toISOString();
  return {
    ...(existing ?? { createdAt: now }),
    code,
    label,
    geometry: geometryTypes[0],
    geometryTypes,
    description:
      typeof body.description === 'string' ? body.description.trim() : '',
    active:
      typeof body.active === 'boolean'
        ? body.active
        : (existing?.active ?? true),
    updatedAt: now,
  };
}

function parsePage(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new BadRequestException('page and pageSize must be integers');
  }
  return Math.max(1, parsed);
}
