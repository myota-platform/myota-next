import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { verifyAccessToken } from '@app/platform/access-token.js';
import { parsePageInteger } from '@app/platform/pagination.js';
import { ProgrammeStateRepository } from './programme-state.repository.js';
import type {
  ProgrammeRecord,
  ProgrammeState,
} from './programme-state.repository.js';
import { ProgrammeRepository } from './programme.repository.js';
import type {
  CreateProgrammeDto,
  EntityTypeDto,
  UpdateProgrammeDto,
} from './programmes.dto.js';

@Injectable()
export class ProgrammesService {
  constructor(
    private readonly state: ProgrammeStateRepository,
    private readonly programmes: ProgrammeRepository,
  ) {}

  async list(query: { page?: string; pageSize?: string }) {
    const page = parsePageInteger(query.page, 1);
    const pageSize = Math.min(100, parsePageInteger(query.pageSize, 50));
    const start = (page - 1) * pageSize;
    const { items, total } = await this.programmes.listPage(pageSize, start);
    return {
      items,
      page,
      pageSize,
      total,
      nextPage: start + pageSize < total ? page + 1 : null,
    };
  }

  async get(slug: string): Promise<ProgrammeRecord> {
    const programme = await this.programmes.get(slug);
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
    const missing = [
      ...(!body.slug ? ['slug'] : []),
      ...(!body.name ? ['name'] : []),
      ...(body.entityTypes?.length ? [] : ['entityTypes']),
      ...(body.rules && Object.keys(body.rules).length > 0 ? [] : ['rules']),
    ];
    if (missing.length) {
      throw new BadRequestException(
        `missing required fields: ${missing.join(', ')}`,
      );
    }
    const slug = body.slug.toLowerCase();
    this.authorizeAdmin(authorization, slug);
    return this.state.mutate(idempotencyKey, async (client, state) => {
      if (await this.programmes.getInTransaction(client, slug)) {
        throw new BadRequestException('programme slug already exists');
      }
      state.data ??= {};
      const catalog = backfillEntityTypeCatalog(
        state,
        await this.programmes.listAll(client),
      );
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
      await this.programmes.create(client, slug, programme);
      await this.state.recordEvent(
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
    return this.state.mutate(idempotencyKey, async (client, state) => {
      const programme = await this.programmes.getInTransaction(client, slug);
      if (!programme) throw new NotFoundException('programme not found');
      if (body.name !== undefined) programme.name = body.name;
      if (body.description !== undefined)
        programme.description = body.description;
      if (body.rules !== undefined) programme.rules = body.rules;
      if (body.theme !== undefined) programme.theme = body.theme;
      if (body.oidc !== undefined) programme.oidc = body.oidc;
      if (body.entityTypes !== undefined) {
        const catalog = backfillEntityTypeCatalog(
          state,
          await this.programmes.listAll(client),
        );
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
      await this.programmes.save(client, programme);
      await this.state.recordEvent(
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

  async listEntityTypeCatalog(authorization?: string) {
    this.authorizeAdmin(authorization);
    const state = await this.state.load();
    const programmes = await this.programmes.all();
    const catalog = backfillEntityTypeCatalog(state, programmes);
    return {
      items: this.catalogWithAssignments(catalog, programmes),
    };
  }

  async listProgrammeEntityTypes(
    authorization: string | undefined,
    slug: string,
  ) {
    this.authorizeAdmin(authorization, slug);
    const state = await this.state.load();
    const programme = await this.programmes.get(slug);
    if (!programme) throw new NotFoundException('programme not found');
    backfillEntityTypeCatalog(state, [programme]);
    return { programmeSlug: slug, items: programme.entityTypes ?? [] };
  }

  async saveEntityTypeCatalog(
    authorization: string | undefined,
    body: EntityTypeDto,
    idempotencyKey?: string,
  ) {
    this.authorizeAdmin(authorization);
    return this.state.mutate(idempotencyKey, async (client, state) => {
      const programmes = await this.programmes.listAll(client);
      const catalog = backfillEntityTypeCatalog(state, programmes);
      const code = body.code.trim().toUpperCase();
      const previous = catalog[code];
      const entityType = normalizeEntityType(body, previous);
      catalog[code] = entityType;
      for (const programme of this.refreshAssignedEntityTypes(
        programmes,
        catalog,
        code,
      )) {
        await this.programmes.save(client, programme);
      }
      await this.state.recordEvent(
        client,
        state,
        'programme.entity-type.catalog-saved.v1',
        'entity_type',
        code,
        { entityType, previous: previous ?? null },
      );
      return {
        statusCode: previous ? 200 : 201,
        entityType,
        items: this.catalogWithAssignments(catalog, programmes),
      };
    });
  }

  async saveAndAssignEntityType(
    authorization: string | undefined,
    slug: string,
    body: EntityTypeDto,
    idempotencyKey?: string,
  ) {
    this.authorizeAdmin(authorization, slug);
    return this.state.mutate(idempotencyKey, async (client, state) => {
      const programmes = await this.programmes.listAll(client);
      const programme = programmes.find((item) => item.slug === slug);
      if (!programme) throw new NotFoundException('programme not found');
      const catalog = backfillEntityTypeCatalog(state, programmes);
      const code = body.code.trim().toUpperCase();
      const previous = catalog[code];
      const entityType = normalizeEntityType(body, previous);
      catalog[code] = entityType;
      for (const assigned of this.refreshAssignedEntityTypes(
        programmes,
        catalog,
        code,
      )) {
        await this.programmes.save(client, assigned);
      }
      await this.state.recordEvent(
        client,
        state,
        'programme.entity-type.catalog-saved.v1',
        'entity_type',
        code,
        { entityType, previous: previous ?? null },
      );
      if (!(programme.entityTypeCodes ?? []).includes(code)) {
        await this.applyAssignment(
          client,
          state,
          programme,
          code,
          catalog,
          true,
        );
      }
      return {
        statusCode: previous ? 200 : 201,
        programmeSlug: slug,
        entityType,
        items: programme.entityTypes ?? [],
      };
    });
  }

  async assignEntityType(
    authorization: string | undefined,
    slug: string,
    codeValue: string,
    idempotencyKey?: string,
  ) {
    this.authorizeAdmin(authorization, slug);
    const code = codeValue.trim().toUpperCase();
    return this.state.mutate(idempotencyKey, async (client, state) => {
      const programme = await this.programmes.getInTransaction(client, slug);
      if (!programme) throw new NotFoundException('programme not found');
      const catalog = backfillEntityTypeCatalog(
        state,
        await this.programmes.listAll(client),
      );
      if (!catalog[code])
        throw new BadRequestException('unknown entity category');
      await this.applyAssignment(client, state, programme, code, catalog, true);
      return {
        programmeSlug: slug,
        items: programme.entityTypes ?? [],
        assigned: catalog[code],
      };
    });
  }

  async unassignEntityType(
    authorization: string | undefined,
    slug: string,
    codeValue: string,
    idempotencyKey?: string,
  ) {
    this.authorizeAdmin(authorization, slug);
    const code = codeValue.trim().toUpperCase();
    return this.state.mutate(idempotencyKey, async (client, state) => {
      const programme = await this.programmes.getInTransaction(client, slug);
      if (!programme) throw new NotFoundException('programme not found');
      const catalog = backfillEntityTypeCatalog(
        state,
        await this.programmes.listAll(client),
      );
      await this.applyAssignment(
        client,
        state,
        programme,
        code,
        catalog,
        false,
      );
      return { programmeSlug: slug, items: programme.entityTypes ?? [] };
    });
  }

  private catalogWithAssignments(
    catalog: Record<string, Record<string, unknown>>,
    programmes: ProgrammeRecord[],
  ): Record<string, unknown>[] {
    const items: Record<string, unknown>[] = Object.values(catalog).map(
      (entityType): Record<string, unknown> => ({
        ...entityType,
        assignedProgrammes: programmes
          .filter((programme) =>
            programme.entityTypeCodes?.includes(String(entityType.code)),
          )
          .map((programme) => programme.slug),
      }),
    );
    return items.sort((left, right) =>
      String(left.code).localeCompare(String(right.code)),
    );
  }

  private refreshAssignedEntityTypes(
    programmes: ProgrammeRecord[],
    catalog: Record<string, Record<string, unknown>>,
    code: string,
  ): ProgrammeRecord[] {
    const updated: ProgrammeRecord[] = [];
    for (const programme of programmes) {
      if (programme.entityTypeCodes?.includes(code)) {
        programme.entityTypes = programme.entityTypeCodes.map(
          (assignedCode) => catalog[assignedCode],
        );
        programme.updatedAt = new Date().toISOString();
        updated.push(programme);
      }
    }
    return updated;
  }

  private async applyAssignment(
    client: PoolClient,
    state: ProgrammeState,
    programme: ProgrammeRecord,
    code: string,
    catalog: Record<string, Record<string, unknown>>,
    assign: boolean,
  ) {
    const currentCodes = programme.entityTypeCodes ?? [];
    const nextCodes = assign
      ? [...new Set([...currentCodes, code])]
      : currentCodes.filter((current) => current !== code);
    if (nextCodes.length === currentCodes.length) return;
    programme.entityTypeCodes = nextCodes;
    programme.entityTypes = nextCodes.map((current) => catalog[current]);
    programme.policyVersion = (programme.policyVersion ?? 1) + 1;
    programme.updatedAt = new Date().toISOString();
    await this.programmes.save(client, programme);
    await this.state.recordEvent(
      client,
      state,
      assign
        ? 'programme.entity-type.assigned.v1'
        : 'programme.entity-type.unassigned.v1',
      'programme',
      programme.id,
      { programmeSlug: programme.slug, code },
    );
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

function backfillEntityTypeCatalog(
  state: ProgrammeState,
  programmes: ProgrammeRecord[],
): Record<string, Record<string, unknown>> {
  const catalog = entityCatalog(state);
  for (const programme of programmes) {
    const legacyTypes = Array.isArray(programme.entityTypes)
      ? programme.entityTypes
      : [];
    for (const value of legacyTypes) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const item = value as Record<string, unknown>;
      const code =
        typeof item.code === 'string' ? item.code.trim().toUpperCase() : '';
      if (!code) continue;
      if (!catalog[code]) catalog[code] = { ...item, code };
      if (!Array.isArray(catalog[code].geometryTypes)) {
        const geometry =
          typeof catalog[code].geometry === 'string'
            ? catalog[code].geometry
            : 'MULTIPOLYGON';
        catalog[code].geometryTypes = [geometry];
      }
    }
    const codes =
      programme.entityTypeCodes ??
      legacyTypes.flatMap((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value))
          return [];
        const code = (value as Record<string, unknown>).code;
        return typeof code === 'string' && code.trim()
          ? [code.trim().toUpperCase()]
          : [];
      });
    programme.entityTypeCodes = [...new Set(codes)];
    programme.entityTypes = programme.entityTypeCodes.flatMap((code) =>
      catalog[code] ? [catalog[code]] : [],
    );
  }
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
  body: EntityTypeDto | Record<string, unknown>,
  existing?: Record<string, unknown>,
): Record<string, unknown> & { code: string } {
  const code =
    typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
  const originalCodeValue = body.originalCode || code;
  const originalCode = (
    typeof originalCodeValue === 'string'
      ? originalCodeValue
      : typeof originalCodeValue === 'number' ||
          typeof originalCodeValue === 'boolean'
        ? String(originalCodeValue)
        : ''
  )
    .trim()
    .toUpperCase();
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
  const rawGeometry = Object.hasOwn(body, 'geometryTypes')
    ? body.geometryTypes
    : body.geometry;
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
  const activeValue = Object.hasOwn(body, 'active')
    ? body.active
    : existing && Object.hasOwn(existing, 'active')
      ? existing.active
      : true;
  return {
    ...(existing ?? { createdAt: now }),
    code,
    label,
    geometry: geometryTypes[0],
    geometryTypes,
    description:
      typeof body.description === 'string' ? body.description.trim() : '',
    active: Boolean(activeValue),
    updatedAt: now,
  };
}
