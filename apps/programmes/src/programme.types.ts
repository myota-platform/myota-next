export interface ProgrammeRecord {
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
