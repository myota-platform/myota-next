export interface ProgrammeRecord {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  entityTypeCodes?: string[];
  rules: unknown;
  entityTypes: unknown[];
  entityNumbering?: ProgrammeEntityNumbering | null;
  policyVersion?: number | bigint;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface ProgrammeEntityNumbering {
  identifier: string;
  qualifierMode: 'NONE' | 'MANUAL' | 'LOCATION';
  qualifierField?: string;
  serialWidth: number;
  assignmentMode: 'PROGRAMME_SEQUENCE' | 'QUALIFIER_SEQUENCE' | 'MANUAL';
}

export function nextPolicyVersion(value: number | bigint | undefined) {
  if (typeof value === 'bigint') return value + 1n;
  return (value ?? 1) + 1;
}
