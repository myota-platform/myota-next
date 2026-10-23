import type { Account } from '../types';

export function grantedScopes(account: Account | null): Set<string> {
  return new Set([
    ...(account?.scopes || []),
    ...(account?.roles || []).flatMap((role) => role.scopes || []),
  ]);
}

export function isGlobalAdministrator(account: Account | null): boolean {
  return (
    grantedScopes(account).has('*') ||
    [account?.role, ...(account?.roles || []).map((role) => role.role)].some(
      (role) =>
        ['GLOBAL_OPERATOR', 'GLOBAL_ADMIN'].includes(
          String(role || '').toUpperCase(),
        ),
    )
  );
}

export function hasAnyScope(
  account: Account | null,
  ...required: string[]
): boolean {
  return (
    Boolean(account) &&
    (isGlobalAdministrator(account) ||
      required.some((scope) => grantedScopes(account).has(scope)))
  );
}

export function canBrowseEntities(account: Account | null): boolean {
  return hasAnyScope(
    account,
    'geodata.read',
    'geodata.review',
    'geodata.import',
    'geodata.geometry.manage',
    'geodata.location.manage',
    'geodata.delete',
    'audit.read',
  );
}

export function canAdministerLocation(account: Account | null): boolean {
  return (
    hasAnyScope(account, 'geodata.location.manage') ||
    Boolean(account?.roles?.some((role) => role.role === 'GIS_ADMIN'))
  );
}

export interface RoleAssignment {
  role: string;
  scopes?: string[];
  programmeSlug?: string | null;
  jurisdiction?: string | null;
  entityType?: string | null;
}

export function mayGrantRole(
  account: Account | null,
  role: { scopes?: string[] },
): boolean {
  if (!account) return false;
  const actorScopes = grantedScopes(account);
  const actorPrivileges = new Set(
    [...actorScopes].filter((scope) => scope !== 'identity.me'),
  );
  const targetScopes = new Set(role.scopes || []);
  if (targetScopes.has('*')) return false;
  if (actorPrivileges.has('*')) return true;
  return (
    targetScopes.size < actorPrivileges.size &&
    [...targetScopes].every((scope) => actorPrivileges.has(scope))
  );
}

/** Retained role codes keep every existing scope-bound assignment, not new global grants. */
export function roleAssignmentPayload(
  selectedCodes: string[],
  original: RoleAssignment[],
): Array<Record<string, string | null | undefined>> {
  return [...new Set(selectedCodes)].flatMap((code) => {
    const retained = original.filter((role) => role.role === code);
    return retained.length
      ? retained.map((role) => ({
          code,
          programmeSlug: role.programmeSlug,
          jurisdiction: role.jurisdiction,
          entityType: role.entityType,
        }))
      : [{ code }];
  });
}
