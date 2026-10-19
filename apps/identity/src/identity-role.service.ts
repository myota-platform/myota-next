import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { writeSecurityEvent } from '@app/platform/outbox.js';
import { IdentityAuthService } from './auth.service.js';
import type { AdminRoleDefinitionDto } from './auth.dto.js';
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

    const result = await this.pool.query<{
      code: string;
      name: string;
      description: string;
      scopes: string[];
      system: boolean;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT role_code AS code, display_name AS name, description, scopes,
              is_system AS system, created_at, updated_at
         FROM public.identity_role_definition`,
    );
    const initialTimestamp = new Date();
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
    const roles = [...definitions.values()].sort((left, right) =>
      left.code.localeCompare(right.code),
    );
    return { items: roles, permissions: ADMIN_PERMISSION_CATALOG };
  }

  async createAdminRole(
    authorization: string,
    body: AdminRoleDefinitionDto,
  ): Promise<RoleDefinition> {
    await this.authorize(
      authorization,
      ['identity.roles.manage'],
      'identity.roles.manage scope is required',
    );
    if (!body.code || !body.name) {
      throw new BadRequestException('code and name are required');
    }
    const code = body.code
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '');
    const name = body.name.trim();
    if (!code || !name) {
      throw new BadRequestException('role code and name must not be empty');
    }
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
        throw new ConflictException('role code is empty or already exists');
      }
      const result = await client.query<{
        code: string;
        name: string;
        description: string;
        scopes: string[];
        system: boolean;
        created_at: Date;
        updated_at: Date;
      }>(
        `INSERT INTO public.identity_role_definition
           (role_code, display_name, description, scopes, is_system)
         VALUES ($1, $2, $3, $4, false)
         RETURNING role_code AS code, display_name AS name, description, scopes,
                   is_system AS system, created_at, updated_at`,
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
        throw new ConflictException('role code is empty or already exists');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async updateAdminRole(
    authorization: string,
    roleCode: string,
    body: AdminRoleDefinitionDto,
  ): Promise<RoleDefinition> {
    await this.authorize(
      authorization,
      ['identity.roles.manage'],
      'identity.roles.manage scope is required',
    );
    const code = roleCode.trim().toUpperCase();
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<{
        code: string;
        name: string;
        description: string;
        scopes: string[];
        system: boolean;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT role_code AS code, display_name AS name, description, scopes,
                is_system AS system, created_at, updated_at
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
        throw new NotFoundException('role definition not found');
      }
      if (current.system) {
        throw new BadRequestException(
          'built-in role definitions cannot be edited',
        );
      }
      const name = body.name === undefined ? current.name : body.name.trim();
      if (!name) throw new BadRequestException('role name must not be empty');
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
                    is_system AS system, created_at, updated_at`,
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
  created_at: Date;
  updated_at: Date;
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
