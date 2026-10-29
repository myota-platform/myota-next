import type { PoolClient } from 'pg';

export interface ProgrammeEntityNumberingPolicy {
  identifier: string;
  qualifierMode: 'NONE' | 'MANUAL' | 'LOCATION';
  qualifierField?: string;
  serialWidth: number;
  assignmentMode: 'PROGRAMME_SEQUENCE' | 'QUALIFIER_SEQUENCE' | 'MANUAL';
}

export interface ManualEntityIdentifierAssignment {
  qualifier?: unknown;
  serial?: unknown;
}

export class ProgrammeEntityIdentifierError extends Error {}

export interface ProgrammeEntityIdentifierSuggestion {
  entityIdentifier: string;
  serial: number;
  paddedSerial: string;
  qualifier: string | null;
}

/**
 * Find the lowest unreserved serial in the policy's assignment scope.
 * Suggestions are advisory; allocation still reserves the selected serial
 * inside the entity transaction and reports a conflict if another writer wins.
 */
export async function findNextFreeProgrammeEntitySerial(
  client: Pick<PoolClient, 'query'>,
  programmeSlug: string,
  policy: ProgrammeEntityNumberingPolicy,
  qualifier: string | null,
): Promise<number> {
  const programmeWide =
    policy.assignmentMode === 'PROGRAMME_SEQUENCE' || qualifier === null;
  const result = await client.query<{ next_serial: number | string }>(
    `WITH used AS (
       SELECT serial_number,
              lag(serial_number,1,0) OVER (ORDER BY serial_number) AS previous_serial
         FROM geodata_entity_identifier_reservation
        WHERE programme_slug=$1
          ${programmeWide ? '' : "AND (qualifier_scope=$2 OR qualifier_scope='')"}
     ), first_gap AS (
       SELECT previous_serial+1 AS next_serial
         FROM used
        WHERE serial_number > previous_serial+1
        ORDER BY serial_number
        LIMIT 1
     ), after_last AS (
       SELECT COALESCE(MAX(serial_number),0)+1 AS next_serial FROM used
     )
     SELECT COALESCE((SELECT next_serial FROM first_gap),
                     (SELECT next_serial FROM after_last)) AS next_serial`,
    programmeWide ? [programmeSlug] : [programmeSlug, qualifier ?? ''],
  );
  return Number(result.rows[0]?.next_serial ?? 1);
}

/**
 * Return an advisory manual serial without reserving it. The final allocator
 * repeats the uniqueness check while holding the owning transaction's locks.
 */
export function suggestProgrammeEntityIdentifier(
  policy: ProgrammeEntityNumberingPolicy,
  properties: Record<string, unknown>,
  manualAssignment: ManualEntityIdentifierAssignment | undefined,
  nextSerial: number,
): ProgrammeEntityIdentifierSuggestion {
  if (policy.assignmentMode !== 'MANUAL')
    throw new ProgrammeEntityIdentifierError(
      'serial suggestions are available only for manual assignment policies',
    );
  if (
    !Number.isInteger(policy.serialWidth) ||
    policy.serialWidth < 3 ||
    policy.serialWidth > 6
  )
    throw new ProgrammeEntityIdentifierError(
      'programme entity identifier serial width must be 3 to 6 digits',
    );
  const maximum = 10 ** policy.serialWidth - 1;
  if (
    !Number.isSafeInteger(nextSerial) ||
    nextSerial < 1 ||
    nextSerial > maximum
  )
    throw new ProgrammeEntityIdentifierError(
      `programme entity identifier serial range is exhausted at ${maximum}`,
    );
  const qualifier = resolveQualifier(policy, properties, manualAssignment);
  const paddedSerial = String(nextSerial).padStart(policy.serialWidth, '0');
  return {
    entityIdentifier: [
      policy.identifier,
      ...(qualifier ? [qualifier] : []),
      paddedSerial,
    ].join('-'),
    serial: nextSerial,
    paddedSerial,
    qualifier: qualifier || null,
  };
}

export async function allocateProgrammeEntityIdentifier(
  client: PoolClient,
  programmeSlug: string,
  policy: ProgrammeEntityNumberingPolicy | null,
  entityId: string,
  properties: Record<string, unknown>,
  existingIdentifier: string | null,
  manualAssignment?: ManualEntityIdentifierAssignment,
): Promise<string | null> {
  if (existingIdentifier) return existingIdentifier;
  if (!policy) return null;
  if (!/^[A-Z0-9]{1,4}$/.test(policy.identifier))
    throw new ProgrammeEntityIdentifierError(
      'programme entity identifier policy is invalid',
    );
  if (
    !Number.isInteger(policy.serialWidth) ||
    policy.serialWidth < 3 ||
    policy.serialWidth > 6
  )
    throw new ProgrammeEntityIdentifierError(
      'programme entity identifier serial width must be 3 to 6 digits',
    );

  const qualifier = resolveQualifier(policy, properties, manualAssignment);
  const scope =
    policy.assignmentMode === 'QUALIFIER_SEQUENCE' ||
    policy.assignmentMode === 'MANUAL'
      ? qualifier
      : '';
  const maximum = 10 ** policy.serialWidth - 1;
  let serial: number;

  if (policy.assignmentMode === 'MANUAL') {
    serial = parseManualSerial(manualAssignment?.serial, maximum);
    const proposedIdentifier = [
      policy.identifier,
      ...(qualifier ? [qualifier] : []),
      String(serial).padStart(policy.serialWidth, '0'),
    ].join('-');
    const existing = await client.query(
      `SELECT 1 FROM geodata_entity_identifier_reservation
        WHERE entity_identifier=$1
           OR (programme_slug=$2 AND serial_number=$4
               AND ($3='' OR qualifier_scope=$3 OR qualifier_scope=''))
        LIMIT 1`,
      [proposedIdentifier, programmeSlug, scope, serial],
    );
    if (existing.rowCount)
      throw new ProgrammeEntityIdentifierError(
        'that serial number is already assigned in this programme scope',
      );
  } else {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('geodata:entity-id:' || $1 || ':' || $2,0))",
      [programmeSlug, scope],
    );
    // Policy changes must advance past reservations made in the prior scope.
    const programmeWide = policy.assignmentMode === 'PROGRAMME_SEQUENCE';
    const next = await client.query<{ next_serial: number | string }>(
      programmeWide
        ? `SELECT COALESCE(MAX(serial_number),0)+1 AS next_serial
             FROM geodata_entity_identifier_reservation
            WHERE programme_slug=$1`
        : `SELECT COALESCE(MAX(serial_number),0)+1 AS next_serial
             FROM geodata_entity_identifier_reservation
            WHERE programme_slug=$1
              AND (qualifier_scope=$2 OR qualifier_scope='')`,
      programmeWide ? [programmeSlug] : [programmeSlug, scope],
    );
    serial = Number(next.rows[0]?.next_serial ?? 1);
    if (serial > maximum)
      throw new ProgrammeEntityIdentifierError(
        `programme entity identifier serial range is exhausted at ${maximum}`,
      );
  }

  const entityIdentifier = [
    policy.identifier,
    ...(qualifier ? [qualifier] : []),
    String(serial).padStart(policy.serialWidth, '0'),
  ].join('-');
  try {
    await client.query(
      `INSERT INTO geodata_entity_identifier_reservation
         (entity_identifier,programme_slug,qualifier_scope,serial_number,entity_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [entityIdentifier, programmeSlug, scope, serial, entityId],
    );
  } catch (error) {
    if (isUniqueViolation(error))
      throw new ProgrammeEntityIdentifierError(
        'programme entity identifier was assigned concurrently; retry with the latest suggestion',
      );
    throw error;
  }
  return entityIdentifier;
}

export function normalizeEntityIdentifierQualifier(value: unknown): string {
  if (value === undefined || value === null || value === '')
    throw new ProgrammeEntityIdentifierError(
      'a qualifier value is required by this programme numbering policy',
    );
  if (typeof value !== 'string')
    throw new ProgrammeEntityIdentifierError(
      'the qualifier source must contain a single text value',
    );
  if (!value.trim())
    throw new ProgrammeEntityIdentifierError(
      'a qualifier value is required by this programme numbering policy',
    );
  const normalized = value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (!normalized || normalized.length > 24)
    throw new ProgrammeEntityIdentifierError(
      'the normalized entity ID qualifier must contain 1 to 24 letters or digits',
    );
  return normalized;
}

function resolveQualifier(
  policy: ProgrammeEntityNumberingPolicy,
  properties: Record<string, unknown>,
  manualAssignment?: ManualEntityIdentifierAssignment,
): string {
  if (policy.qualifierMode === 'NONE') return '';
  let value: unknown;
  if (policy.qualifierMode === 'MANUAL') {
    value = manualAssignment?.qualifier ?? properties.entityIdQualifier;
  } else {
    if (!policy.qualifierField)
      throw new ProgrammeEntityIdentifierError(
        'location qualifier field is missing from programme policy',
      );
    const location = isRecord(properties.location) ? properties.location : {};
    value =
      properties[policy.qualifierField] ?? location[policy.qualifierField];
  }
  return normalizeEntityIdentifierQualifier(value);
}

function parseManualSerial(value: unknown, maximum: number): number {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d+$/.test(text))
    throw new ProgrammeEntityIdentifierError(
      'enter a positive numeric serial for this entity',
    );
  const serial = Number(text);
  if (!Number.isSafeInteger(serial) || serial < 1 || serial > maximum)
    throw new ProgrammeEntityIdentifierError(
      `serial number must be between 1 and ${maximum}`,
    );
  return serial;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}
