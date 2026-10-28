import type { ProgrammeEntityNumberingPolicy } from './programme-entity-identifier.js';

export async function loadProgrammeNumberingPolicy(
  programmeSlug: string,
  baseUrl = process.env.MYOTA_PROGRAMMES_URL,
  request: typeof fetch = fetch,
): Promise<ProgrammeEntityNumberingPolicy | null> {
  if (!baseUrl)
    throw new Error(
      'MYOTA_PROGRAMMES_URL is required for programme entity IDs',
    );
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/v1/programmes/${encodeURIComponent(programmeSlug)}/policy`;
  const response = await request(endpoint, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok)
    throw new Error(
      `Programme policy request failed with HTTP ${response.status}`,
    );
  const result: unknown = await response.json();
  if (!isRecord(result))
    throw new Error('Programme policy response is invalid');
  const policy = result.entityNumbering;
  if (policy === null || policy === undefined) return null;
  if (
    !isRecord(policy) ||
    typeof policy.identifier !== 'string' ||
    !['NONE', 'MANUAL', 'LOCATION'].includes(String(policy.qualifierMode)) ||
    !Number.isInteger(policy.serialWidth) ||
    !['PROGRAMME_SEQUENCE', 'QUALIFIER_SEQUENCE', 'MANUAL'].includes(
      String(policy.assignmentMode),
    )
  ) {
    throw new Error('Programme entity numbering policy response is invalid');
  }
  return policy as unknown as ProgrammeEntityNumberingPolicy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
