export interface ProgrammeRecord {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  entityTypeCodes?: string[];
  rules: unknown;
  entityTypes: unknown[];
  policyVersion?: number;
  updatedAt?: string;
  [key: string]: unknown;
}
