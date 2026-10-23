export interface ProgrammeRecord {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  entityTypeCodes?: string[];
  rules: unknown;
  entityTypes: unknown[];
  policyVersion?: number | bigint;
  updatedAt?: string;
  [key: string]: unknown;
}

export function nextPolicyVersion(value: number | bigint | undefined) {
  if (typeof value === 'bigint') return value + 1n;
  return (value ?? 1) + 1;
}
