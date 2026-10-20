import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { verifyAccessToken } from '@app/platform/access-token.js';
import { pythonTruthy } from '@app/platform/python-truthiness.js';
import { comparePythonStrings } from '@app/platform/python-string.js';
import {
  nextPageIfMore,
  pageOffset,
  parsePageInteger,
} from '@app/platform/pagination.js';
import { normalizePythonNumericText } from '@app/platform/python-numeric.js';
import { trimPythonWhitespace } from '@app/platform/python-strings.js';
import { nextPolicyVersion, type ProgrammeRecord } from './programme.types.js';
import { ProgrammeMutationRepository } from './programme-mutation.repository.js';
import { ProgrammeRepository } from './programme.repository.js';
import { ProgrammeEntityTypeRepository } from './programme-entity-type.repository.js';
import type {
  CreateProgrammeDto,
  EntityTypeDto,
  UpdateProgrammeDto,
} from './programmes.dto.js';

@Injectable()
export class ProgrammesService {
  constructor(
    private readonly mutations: ProgrammeMutationRepository,
    private readonly programmes: ProgrammeRepository,
    private readonly entityTypes: ProgrammeEntityTypeRepository,
  ) {}

  async list(query: { page?: string; pageSize?: string }) {
    const page = parsePageInteger(query.page, 1);
    const pageSize = parsePageInteger(query.pageSize, 50, 100);
    const start = pageOffset(page, pageSize);
    const { items, total } = await this.programmes.listPage(pageSize, start);
    return {
      items,
      page,
      pageSize,
      total,
      nextPage: nextPageIfMore(page, pageSize, total),
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
    return this.mutations.mutate(idempotencyKey, async (client) => {
      if (await this.programmes.getInTransaction(client, slug)) {
        throw new BadRequestException('programme slug already exists');
      }
      const catalog = await this.entityTypes.listAll(client);
      const normalizedTypes = body.entityTypes.map((entityType) =>
        normalizeEntityType(entityType),
      );
      for (const entityType of normalizedTypes) {
        if (!catalog[entityType.code]) {
          catalog[entityType.code] = entityType;
          await this.entityTypes.save(client, entityType);
        }
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
        description: body.description !== undefined ? body.description : '',
        entityTypeCodes,
        entityTypes,
        rules: body.rules,
        policyVersion:
          body.policyVersion !== undefined
            ? parsePythonPolicyVersion(body.policyVersion)
            : 1,
        theme:
          body.theme !== undefined
            ? body.theme
            : { primary: '#0f766e', accent: '#f59e0b' },
        oidc: body.oidc ?? null,
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      };
      await this.programmes.create(client, slug, programme);
      await this.mutations.recordEvent(
        client,
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
    if (
      status !== undefined &&
      status !== null &&
      status !== 'ACTIVE' &&
      status !== 'ARCHIVED'
    ) {
      throw new BadRequestException('status must be ACTIVE or ARCHIVED');
    }
    return this.mutations.mutate(idempotencyKey, async (client) => {
      const programme = await this.programmes.getInTransaction(client, slug);
      if (!programme) throw new NotFoundException('programme not found');
      if (status === 'ARCHIVED') {
        programme.status = 'ARCHIVED';
        programme.updatedAt = new Date().toISOString();
        await this.programmes.save(client, programme);
        await this.mutations.recordEvent(
          client,
          'programme.archived.v1',
          'programme',
          programme.id,
          { slug },
        );
        return programme;
      }
      if (body.name !== undefined) programme.name = body.name;
      if (body.description !== undefined)
        programme.description = body.description;
      if (body.rules !== undefined) programme.rules = body.rules;
      if (body.theme !== undefined) programme.theme = body.theme;
      if (body.oidc !== undefined) programme.oidc = body.oidc;
      if (body.entityTypes !== undefined) {
        const catalog = await this.entityTypes.listAll(client);
        const codes: string[] = [];
        for (const item of body.entityTypes) {
          const code =
            typeof item.code === 'string'
              ? trimPythonWhitespace(item.code).toUpperCase()
              : '';
          const normalized = normalizeEntityType(item, catalog[code]);
          if (!catalog[code]) {
            catalog[code] = normalized;
            await this.entityTypes.save(client, normalized);
          }
          codes.push(code);
        }
        programme.entityTypeCodes = [...new Set(codes)];
        programme.entityTypes = programme.entityTypeCodes.map(
          (code) => catalog[code],
        );
      }
      if (body.rules !== undefined || body.entityTypes !== undefined) {
        programme.policyVersion = nextPolicyVersion(programme.policyVersion);
      }
      programme.updatedAt = new Date().toISOString();
      await this.programmes.save(client, programme);
      await this.mutations.recordEvent(
        client,
        'programme.updated.v1',
        'programme',
        programme.id,
        programme,
      );
      return programme;
    });
  }

  async listEntityTypeCatalog(authorization?: string) {
    this.authorizeAdmin(authorization);
    const programmes = await this.programmes.all();
    const catalog = await this.entityTypes.all();
    return {
      items: this.catalogWithAssignments(catalog, programmes),
    };
  }

  async listProgrammeEntityTypes(
    authorization: string | undefined,
    slug: string,
  ) {
    this.authorizeAdmin(authorization, slug);
    const programme = await this.programmes.get(slug);
    if (!programme) throw new NotFoundException('programme not found');
    return { programmeSlug: slug, items: programme.entityTypes ?? [] };
  }

  async saveEntityTypeCatalog(
    authorization: string | undefined,
    body: EntityTypeDto,
    idempotencyKey?: string,
  ) {
    this.authorizeAdmin(authorization);
    return this.mutations.mutate(idempotencyKey, async (client) => {
      const programmes = await this.programmes.listAll(client);
      const catalog = await this.entityTypes.listAll(client);
      const code = trimPythonWhitespace(body.code).toUpperCase();
      const previous = catalog[code];
      const entityType = normalizeEntityType(body, previous);
      catalog[code] = entityType;
      await this.entityTypes.save(client, entityType);
      for (const programme of this.refreshAssignedEntityTypes(
        programmes,
        catalog,
        code,
      )) {
        await this.programmes.save(client, programme);
      }
      await this.mutations.recordEvent(
        client,
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
    return this.mutations.mutate(idempotencyKey, async (client) => {
      const programmes = await this.programmes.listAll(client);
      const programme = programmes.find((item) => item.slug === slug);
      if (!programme) throw new NotFoundException('programme not found');
      const catalog = await this.entityTypes.listAll(client);
      const code = trimPythonWhitespace(body.code).toUpperCase();
      const previous = catalog[code];
      const entityType = normalizeEntityType(body, previous);
      catalog[code] = entityType;
      await this.entityTypes.save(client, entityType);
      for (const assigned of this.refreshAssignedEntityTypes(
        programmes,
        catalog,
        code,
      )) {
        await this.programmes.save(client, assigned);
      }
      await this.mutations.recordEvent(
        client,
        'programme.entity-type.catalog-saved.v1',
        'entity_type',
        code,
        { entityType, previous: previous ?? null },
      );
      if (!(programme.entityTypeCodes ?? []).includes(code)) {
        await this.applyAssignment(client, programme, code, catalog, true);
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
    const code = trimPythonWhitespace(codeValue).toUpperCase();
    return this.mutations.mutate(idempotencyKey, async (client) => {
      const programme = await this.programmes.getInTransaction(client, slug);
      if (!programme) throw new NotFoundException('programme not found');
      const catalog = await this.entityTypes.listAll(client);
      if (!catalog[code])
        throw new BadRequestException('unknown entity category');
      await this.applyAssignment(client, programme, code, catalog, true);
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
    const code = trimPythonWhitespace(codeValue).toUpperCase();
    return this.mutations.mutate(idempotencyKey, async (client) => {
      const programme = await this.programmes.getInTransaction(client, slug);
      if (!programme) throw new NotFoundException('programme not found');
      const catalog = await this.entityTypes.listAll(client);
      await this.applyAssignment(client, programme, code, catalog, false);
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
      comparePythonStrings(String(left.code), String(right.code)),
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
    programme.policyVersion = nextPolicyVersion(programme.policyVersion);
    programme.updatedAt = new Date().toISOString();
    await this.programmes.save(client, programme);
    await this.mutations.recordEvent(
      client,
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

function parsePythonPolicyVersion(value: unknown): number | bigint {
  if (typeof value === 'boolean') return Number(value);
  if (typeof value === 'bigint') return safeInteger(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return safeInteger(BigInt(Math.trunc(value)));
  if (typeof value === 'string') {
    const normalized = normalizePythonNumericText(value);
    if (/^[+-]?\d(?:_?\d)*$/.test(normalized)) {
      const integer = BigInt(normalized.replaceAll('_', ''));
      return safeInteger(integer);
    }
  }
  throw new BadRequestException('policyVersion must be an integer');
}

function safeInteger(value: bigint): number | bigint {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) &&
    value >= BigInt(Number.MIN_SAFE_INTEGER)
    ? Number(value)
    : value;
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
    typeof body.code === 'string'
      ? trimPythonWhitespace(body.code).toUpperCase()
      : '';
  const originalCodeValue = body.originalCode || code;
  const originalCode = trimPythonWhitespace(
    typeof originalCodeValue === 'string'
      ? originalCodeValue
      : typeof originalCodeValue === 'number' ||
          typeof originalCodeValue === 'boolean'
        ? String(originalCodeValue)
        : '',
  ).toUpperCase();
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
  const rawGeometry =
    body.geometryTypes !== undefined ? body.geometryTypes : body.geometry;
  const geometryList = Array.isArray(rawGeometry)
    ? rawGeometry
    : typeof rawGeometry === 'string'
      ? [rawGeometry]
      : [];
  const geometryTypes = [
    ...new Set(
      geometryList.map((value) => {
        const geometry =
          typeof value === 'string'
            ? trimPythonWhitespace(value).toUpperCase()
            : '';
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
  const label =
    typeof body.label === 'string' ? trimPythonWhitespace(body.label) : '';
  if (!label) throw new BadRequestException('category label must not be empty');
  const now = new Date().toISOString();
  const activeValue =
    body.active !== undefined
      ? body.active
      : existing && existing.active !== undefined
        ? existing.active
        : true;
  return {
    ...(existing ?? { createdAt: now }),
    code,
    label,
    geometry: geometryTypes[0],
    geometryTypes,
    description:
      typeof body.description === 'string'
        ? trimPythonWhitespace(body.description)
        : '',
    active: pythonTruthy(activeValue),
    updatedAt: now,
  };
}
