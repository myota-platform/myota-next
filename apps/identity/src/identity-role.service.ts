import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  ValidationPipe,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { writeSecurityEvent } from '@app/platform/outbox.js';
import {
  pythonKeyErrorDetail,
  pythonStringJsonField,
  trimPythonWhitespace,
} from '@app/platform/python-strings.js';
import { pythonTruthy } from '@app/platform/python-truthiness.js';
import { IdentityAuthService } from './auth.service.js';
import { AdminRoleDefinitionDto } from './auth.dto.js';
import {
  ADMIN_PERMISSION_CATALOG,
  DEFAULT_ROLE_DEFINITIONS,
  type RoleDefinition,
} from './role-catalog.js';

@Injectable()
export class IdentityRoleService {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
    private readonly auth: IdentityAuthService,
  ) {}

  async listAdminRoles(authorization: string) {
    await this.authorize(authorization, [
      'identity.admin',
      'identity.accounts.create',
      'identity.roles.assign',
      'identity.roles.manage',
    ]);
    if (!this.pool) {
      throw new ServiceUnavailableException(
        'Identity database is not configured',
      );
    }

    const client = await this.pool.connect();
    try {
      return {
        items: await this.readRoleDefinitionsForTransaction(client),
        permissions: ADMIN_PERMISSION_CATALOG,
      };
    } finally {
      client.release();
    }
  }

  async readRoleDefinitionsForTransaction(
    client: PoolClient,
  ): Promise<RoleDefinition[]> {
    const result = await client.query<{
      code: string;
      name: string;
      description: string;
      scopes: string[];
      system: boolean;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT role_code AS code, display_name AS name, description, scopes,
              is_system AS system,
              to_char(created_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
              to_char(updated_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
         FROM public.identity_role_definition`,
    );
    const initialTimestamp = (
      await client.query<{ timestamp: string }>(
        `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS timestamp`,
      )
    ).rows[0].timestamp;
    const definitions = new Map<string, RoleDefinition>(
      DEFAULT_ROLE_DEFINITIONS.map((definition) => [
        definition.code,
        {
          ...definition,
          createdAt: initialTimestamp,
          updatedAt: initialTimestamp,
        },
      ]),
    );
    for (const row of result.rows) {
      definitions.set(row.code, {
        code: row.code,
        name: row.name,
        description: row.description,
        scopes: row.scopes.filter((scope) => scope !== 'operations.read'),
        system: row.system,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }
    return [...definitions.values()].sort((left, right) =>
      left.code < right.code ? -1 : left.code > right.code ? 1 : 0,
    );
  }

  async createAdminRole(
    authorization: string,
    rawBody: unknown,
  ): Promise<RoleDefinition> {
    await this.authorize(
      authorization,
      ['identity.roles.manage'],
      'identity.roles.manage scope is required',
    );
    const source = asRecord(rawBody);
    const missing = ['code', 'name'].filter(
      (field) => !pythonTruthy(source[field]),
    );
    if (missing.length)
      throw new BadRequestException(
        `missing required fields: ${missing.join(', ')}`,
      );
    const body = await validateAdminRoleDefinitionBody({
      ...source,
      code: pythonStringJsonField(source, 'code'),
      name: pythonStringJsonField(source, 'name'),
      description: pythonTruthy(source.description) ? source.description : '',
    });
    const code = trimPythonWhitespace(body.code ?? '')
      .toUpperCase()
      .replace(/[^A-Z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '');
    const name = trimPythonWhitespace(body.name ?? '');
    if (!code)
      throw new BadRequestException('role code is empty or already exists');
    const scopes = this.validateScopes(body.scopes ?? []);
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const exists = await client.query(
        'SELECT 1 FROM public.identity_role_definition WHERE role_code = $1',
        [code],
      );
      if (
        exists.rowCount ||
        DEFAULT_ROLE_DEFINITIONS.some((role) => role.code === code)
      ) {
        throw new BadRequestException('role code is empty or already exists');
      }
      const result = await client.query<{
        code: string;
        name: string;
        description: string;
        scopes: string[];
        system: boolean;
        created_at: string;
        updated_at: string;
      }>(
        `INSERT INTO public.identity_role_definition
           (role_code, display_name, description, scopes, is_system)
         VALUES ($1, $2, $3, $4, false)
         RETURNING role_code AS code, display_name AS name, description, scopes,
                   is_system AS system,
                   to_char(created_at AT TIME ZONE 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
                   to_char(updated_at AT TIME ZONE 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at`,
        [code, name, body.description ?? '', scopes],
      );
      const role = toRoleDefinition(result.rows[0]);
      await this.writeAudit(
        client,
        'identity.role-definition.created.v1',
        role,
      );
      await client.query('COMMIT');
      return role;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (isUniqueViolation(error)) {
        throw new BadRequestException('role code is empty or already exists');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async updateAdminRole(
    authorization: string,
    roleCode: string,
    rawBody: unknown,
  ): Promise<RoleDefinition> {
    await this.authorize(
      authorization,
      ['identity.roles.manage'],
      'identity.roles.manage scope is required',
    );
    const code = roleCode.toUpperCase();
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<{
        code: string;
        name: string;
        description: string;
        scopes: string[];
        system: boolean;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT role_code AS code, display_name AS name, description, scopes,
                is_system AS system,
                to_char(created_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
                to_char(updated_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
           FROM public.identity_role_definition
          WHERE role_code = $1 FOR UPDATE`,
        [code],
      );
      const current = existing.rows[0];
      if (!current) {
        if (DEFAULT_ROLE_DEFINITIONS.some((role) => role.code === code)) {
          throw new BadRequestException(
            'built-in role definitions cannot be edited',
          );
        }
        throw new NotFoundException(pythonKeyErrorDetail(code));
      }
      if (current.system) {
        throw new BadRequestException(
          'built-in role definitions cannot be edited',
        );
      }
      const source = asRecord(rawBody);
      if ('name' in source && !pythonTruthy(source.name))
        throw new BadRequestException('missing required fields: name');
      const normalizedSource = { ...source };
      if ('name' in source)
        normalizedSource.name = pythonStringJsonField(source, 'name');
      if ('description' in source)
        normalizedSource.description = pythonTruthy(source.description)
          ? source.description
          : '';
      const body = await validateAdminRoleDefinitionBody(normalizedSource);
      const name =
        'name' in source ? trimPythonWhitespace(body.name ?? '') : current.name;
      const description = body.description ?? current.description;
      const scopes =
        body.scopes === undefined
          ? current.scopes
          : this.validateScopes(body.scopes);
      const result = await client.query(
        `UPDATE public.identity_role_definition
            SET display_name = $2, description = $3, scopes = $4, updated_at = now()
          WHERE role_code = $1
          RETURNING role_code AS code, display_name AS name, description, scopes,
                    is_system AS system,
                    to_char(created_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
                    to_char(updated_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at`,
        [code, name, description, scopes],
      );
      const role = toRoleDefinition(result.rows[0]);
      await this.writeAudit(
        client,
        'identity.role-definition.updated.v1',
        role,
      );
      await client.query('COMMIT');
      return role;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async authorize(
    authorization: string,
    acceptedScopes: string[],
    message = 'role-catalogue access is required',
  ) {
    const account = await this.auth.currentAccount(authorization);
    const scopes = new Set(account.scopes as string[]);
    if (
      !scopes.has('*') &&
      !acceptedScopes.some((scope) => scopes.has(scope))
    ) {
      throw new ForbiddenException(message);
    }
  }

  private validateScopes(scopes: string[]) {
    const allowed = new Set<string>(
      ADMIN_PERMISSION_CATALOG.map((permission) => permission.code),
    );
    if (scopes.some((scope) => !allowed.has(scope))) {
      throw new BadRequestException(
        'role contains an unknown administrative permission',
      );
    }
    return [...new Set(scopes)].sort();
  }

  private async connect(): Promise<PoolClient> {
    if (!this.pool) {
      throw new ServiceUnavailableException(
        'Identity database is not configured',
      );
    }
    try {
      return await this.pool.connect();
    } catch {
      throw new ServiceUnavailableException('Identity database is unavailable');
    }
  }

  private async writeAudit(
    client: PoolClient,
    eventType: string,
    role: RoleDefinition,
  ) {
    await writeSecurityEvent(client, eventType, { ...role });
  }
}

function toRoleDefinition(row: {
  code: string;
  name: string;
  description: string;
  scopes: string[];
  system: boolean;
  created_at: string;
  updated_at: string;
}): RoleDefinition {
  return {
    code: row.code,
    name: row.name,
    description: row.description,
    scopes: row.scopes.filter((scope) => scope !== 'operations.read'),
    system: row.system,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const adminRoleValidationPipe = new ValidationPipe({
  transform: true,
  whitelist: true,
});

async function validateAdminRoleDefinitionBody(
  body: unknown,
): Promise<AdminRoleDefinitionDto> {
  return (await adminRoleValidationPipe.transform(body, {
    type: 'body',
    metatype: AdminRoleDefinitionDto,
  })) as AdminRoleDefinitionDto;
}
