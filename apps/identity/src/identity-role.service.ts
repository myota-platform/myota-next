import {
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { IdentityAuthService } from './auth.service.js';
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
    const account = await this.auth.currentAccount(authorization);
    const scopes = new Set(account.scopes as string[]);
    const allowed = [
      'identity.admin',
      'identity.accounts.create',
      'identity.roles.assign',
      'identity.roles.manage',
    ];
    if (!scopes.has('*') && !allowed.some((scope) => scopes.has(scope))) {
      throw new ForbiddenException('role-catalogue access is required');
    }
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
}
