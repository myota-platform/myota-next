import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AccessTokenClaims } from '@app/platform/access-token.js';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import type { Pool, PoolClient } from 'pg';
import {
  allocateProgrammeEntityIdentifier,
  ProgrammeEntityIdentifierError,
  suggestProgrammeEntityIdentifier,
  type ManualEntityIdentifierAssignment,
  type ProgrammeEntityNumberingPolicy,
} from '../../geodata-worker/src/programme-entity-identifier.js';
import { loadProgrammePolicy } from '../../geodata-worker/src/programme-policy-client.js';
import {
  assertGisAdminCoverage,
  isRecord,
} from './geodata-entity-mutation.helpers.js';
import {
  lockRequest,
  readRequestResponse,
  replayRequest,
  requestResponse,
} from './geodata-request-idempotency.js';
import { GeodataEntityMutationSupport } from './geodata-entity-mutation-support.js';

const MAX_SYNCHRONOUS_PROGRAMME_ASSIGNMENT = 500;
const ASSIGNMENT_EVENT = 'geodata.entity-programme-assigned.v1';

interface AssignmentInput extends ManualEntityIdentifierAssignment {
  entityId: string;
}

interface ExpectedIdentifier {
  entityId: string;
  entityIdentifier: string;
}

interface AssignmentBody {
  programmeSlug: string;
  entityIds: string[];
  manualAssignments?: AssignmentInput[];
  expectedIdentifiers?: ExpectedIdentifier[];
}

interface AssignmentRow {
  id: string;
  name: string;
  status: string;
  programme_slug: string | null;
  entity_identifier: string | null;
  entity_type_codes: string[];
  jurisdiction: string | null;
  stable_order_key: string;
  public_properties: Record<string, unknown> | null;
  location: Record<string, unknown>;
}

interface ReservationRow {
  qualifier_scope: string;
  serial_number: number;
}

interface ProgrammePolicy {
  entityNumbering: ProgrammeEntityNumberingPolicy;
  entityTypeCodes: string[];
}

@Injectable()
export class GeodataEntityProgrammeAssignmentRepository {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
    private readonly support: GeodataEntityMutationSupport,
  ) {}

  async preview(body: Record<string, unknown>, claims: AccessTokenClaims) {
    const input = parseAssignmentBody(body, false);
    const policy = await this.loadPolicy(input.programmeSlug);
    const client = await this.connect();
    try {
      const entities = await this.loadEntities(client, input.entityIds, false);
      this.validateEntities(entities, input.programmeSlug, policy, claims);
      const reservations = await this.loadReservations(
        client,
        input.programmeSlug,
      );
      let items;
      try {
        items = this.proposeIdentifiers(
          entities,
          policy.entityNumbering,
          reservations,
          input.manualAssignments,
        );
      } catch (error) {
        if (error instanceof ProgrammeEntityIdentifierError)
          throw new BadRequestException(error.message);
        throw error;
      }
      return {
        programmeSlug: input.programmeSlug,
        assignmentMode: policy.entityNumbering.assignmentMode,
        entityCount: items.length,
        items,
      };
    } finally {
      client.release();
    }
  }

  async assign(
    key: string | undefined,
    body: Record<string, unknown>,
    claims: AccessTokenClaims,
    requestHash?: string,
  ) {
    if (key && requestHash) {
      const replay = await replayRequest(
        () => this.connect(),
        'geodata-programme-entity-assignment',
        key,
        requestHash,
      );
      if (replay.found) return replay.response;
    }
    const input = parseAssignmentBody(body, true);
    const policy = await this.loadPolicy(input.programmeSlug);
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      if (key) {
        await lockRequest(client, key);
        const previous = await readRequestResponse(
          client,
          'geodata-programme-entity-assignment',
          key,
          requestHash,
        );
        if (previous.found) {
          await client.query('COMMIT');
          return previous.response;
        }
      }
      const entities = await this.loadEntities(client, input.entityIds, true);
      this.validateEntities(entities, input.programmeSlug, policy, claims);
      await lockIdentifierScopes(
        client,
        input.programmeSlug,
        policy.entityNumbering,
        entities,
        input.manualAssignments,
      );
      const reservations = await this.loadReservations(
        client,
        input.programmeSlug,
      );
      let proposal;
      try {
        proposal = this.proposeIdentifiers(
          entities,
          policy.entityNumbering,
          reservations,
          input.manualAssignments,
        );
      } catch (error) {
        if (error instanceof ProgrammeEntityIdentifierError)
          throw new BadRequestException(error.message);
        throw error;
      }
      assertExpectedIdentifiers(proposal, input.expectedIdentifiers);

      await client.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      const occurredAt = await client.query<{ occurred_at: Date }>(
        'SELECT now() AS occurred_at',
      );
      const eventTime = occurredAt.rows[0]!.occurred_at;
      const assigned: Array<Record<string, unknown>> = [];
      for (const item of proposal) {
        const entity = entities.find(
          (candidate) => candidate.id === item.entityId,
        )!;
        const manual = assignmentFor(input.manualAssignments, item.entityId);
        const allocated = await allocateProgrammeEntityIdentifier(
          client,
          input.programmeSlug,
          policy.entityNumbering,
          item.entityId,
          entityProperties(entity),
          null,
          manual,
        ).catch((error: unknown) => {
          if (error instanceof ProgrammeEntityIdentifierError)
            throw new ConflictException(error.message);
          throw error;
        });
        if (allocated !== item.entityIdentifier)
          throw new ConflictException(
            `the suggested ID for ${item.entityId} changed; preview the selection again`,
          );
        const updated = await client.query(
          `UPDATE geodata_entity
              SET programme_slug=$2,entity_identifier=$3,updated_at=now()
            WHERE id=$1 AND programme_slug IS NULL AND entity_identifier IS NULL
            RETURNING id::text AS id`,
          [item.entityId, input.programmeSlug, allocated],
        );
        if (!updated.rowCount)
          throw new ConflictException(
            `entity ${item.entityId} changed after preview; no entities were assigned`,
          );
        const eventPayload = {
          entityId: item.entityId,
          programmeSlug: input.programmeSlug,
          entityIdentifier: allocated,
          entityTypeCodes: entity.entity_type_codes,
          assignedBy: claims.sub,
        };
        await this.support.writeEntityEvent(
          client,
          item.entityId,
          ASSIGNMENT_EVENT,
          eventPayload,
          eventTime,
        );
        assigned.push({ ...item, entityIdentifier: allocated });
      }
      const response = {
        programmeSlug: input.programmeSlug,
        assignedCount: assigned.length,
        items: assigned,
      };
      if (key)
        await client.query(
          'INSERT INTO idempotency_record(service,key,response) VALUES ($1,$2,$3::jsonb)',
          [
            'geodata-programme-entity-assignment',
            key,
            stringifyJsonWithBigInts(requestResponse(response, requestHash)),
          ],
        );
      await client.query('COMMIT');
      return response;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadPolicy(programmeSlug: string): Promise<ProgrammePolicy> {
    const policy = await loadProgrammePolicy(programmeSlug).catch(() => {
      throw new ServiceUnavailableException(
        'programme configuration is unavailable',
      );
    });
    if (!policy.entityNumbering)
      throw new BadRequestException(
        'the target programme has no entity ID numbering policy',
      );
    return {
      entityNumbering: policy.entityNumbering,
      entityTypeCodes: policy.entityTypeCodes,
    };
  }

  private validateEntities(
    entities: AssignmentRow[],
    programmeSlug: string,
    policy: ProgrammePolicy,
    claims: AccessTokenClaims,
  ) {
    for (const entity of entities) {
      if (entity.programme_slug || entity.entity_identifier)
        throw new ConflictException(
          `entity ${entity.id} already has programme membership or an immutable ID`,
        );
      if (entity.status !== 'APPROVED')
        throw new ConflictException(
          `entity ${entity.id} must be approved before programme assignment`,
        );
      if (
        !entity.entity_type_codes.some((code) =>
          policy.entityTypeCodes.includes(code),
        )
      )
        throw new BadRequestException(
          `entity ${entity.id} has no category assigned to programme ${programmeSlug}`,
        );
      assertGisAdminCoverage(
        claims,
        { ...entity, programme_slug: programmeSlug },
        'geodata.location.manage',
      );
    }
  }

  private async loadEntities(
    client: PoolClient,
    ids: string[],
    forUpdate: boolean,
  ): Promise<AssignmentRow[]> {
    const result = await client.query<AssignmentRow>(
      `SELECT e.id::text AS id,e.name,e.lifecycle_status AS status,
              e.programme_slug,e.entity_identifier,e.jurisdiction,
              COALESCE(
                (SELECT min(s.adapter_code || ':' || s.source_record_id)
                   FROM source_reference s WHERE s.entity_id=e.id),
                e.id::text
              ) AS stable_order_key,
              COALESCE(
                (SELECT array_agg(c.category_code ORDER BY c.ordinal)
                   FROM geodata_entity_category c WHERE c.entity_id=e.id),
                ARRAY[]::text[]
              ) AS entity_type_codes,
              e.public_properties,
              jsonb_build_object(
                'continent',e.continent,'continentCode',e.continent_code,
                'country',e.country,'countryCode',e.country_code,
                'region',e.region,'regionCode',e.region_code,
                'subdivision',e.subdivision,'subdivisionCode',e.subdivision_code,
                'province',e.province,'provinceCode',e.province_code,
                'county',e.county,'countyCode',e.county_code,
                'city',e.city,'municipality',e.municipality,'locality',e.locality
              ) AS location
         FROM geodata_entity e
        WHERE e.id=ANY($1::uuid[])
        ORDER BY stable_order_key,e.id${forUpdate ? ' FOR UPDATE OF e' : ''}`,
      [ids],
    );
    if (result.rows.length !== ids.length)
      throw new BadRequestException(
        'one or more selected entities no longer exist; refresh the selection',
      );
    return result.rows;
  }

  private async loadReservations(
    client: PoolClient,
    programmeSlug: string,
  ): Promise<ReservationRow[]> {
    const result = await client.query<ReservationRow>(
      `SELECT qualifier_scope,serial_number
         FROM geodata_entity_identifier_reservation
        WHERE programme_slug=$1 ORDER BY qualifier_scope,serial_number`,
      [programmeSlug],
    );
    return result.rows.map((row) => ({
      qualifier_scope: row.qualifier_scope,
      serial_number: Number(row.serial_number),
    }));
  }

  private proposeIdentifiers(
    entities: AssignmentRow[],
    policy: ProgrammeEntityNumberingPolicy,
    reservations: ReservationRow[],
    assignments: AssignmentInput[],
  ) {
    const used = reservations.map((item) => ({
      scope: item.qualifier_scope,
      serial: item.serial_number,
    }));
    const counters = new Map<string, number>();
    return entities.map((entity) => {
      const manual = assignmentFor(assignments, entity.id);
      const properties = entityProperties(entity);
      const qualifierResult = suggestProgrammeEntityIdentifier(
        { ...policy, assignmentMode: 'MANUAL' },
        properties,
        manual,
        1,
      );
      const qualifier = qualifierResult.qualifier ?? '';
      const counterScope =
        policy.assignmentMode === 'PROGRAMME_SEQUENCE' ? '' : qualifier;
      let serial: number;
      if (policy.assignmentMode === 'MANUAL' && manual?.serial !== undefined) {
        serial = positiveSerial(manual.serial, policy.serialWidth);
      } else if (policy.assignmentMode === 'MANUAL') {
        serial = firstUnusedSerial(used, qualifier);
      } else {
        serial =
          counters.get(counterScope) ?? maxSerial(used, counterScope) + 1;
      }
      if (serial > 10 ** policy.serialWidth - 1)
        throw new ConflictException(
          `programme entity identifier serial range is exhausted for ${entity.id}`,
        );
      if (
        used.some(
          (item) =>
            item.serial === serial && scopesConflict(item.scope, qualifier),
        )
      )
        throw new ConflictException(
          `serial ${serial} is already assigned in this programme scope`,
        );
      used.push({ scope: counterScopeFor(policy, qualifier), serial });
      if (policy.assignmentMode !== 'MANUAL')
        counters.set(counterScope, serial + 1);
      const preview = suggestProgrammeEntityIdentifier(
        { ...policy, assignmentMode: 'MANUAL' },
        properties,
        { ...manual, qualifier: manual?.qualifier ?? qualifier },
        serial,
      );
      return {
        entityId: entity.id,
        name: entity.name,
        sourceOrder: entity.stable_order_key,
        entityIdentifier: preview.entityIdentifier,
        qualifier: preview.qualifier,
        serial: preview.serial,
        entityTypeCodes: entity.entity_type_codes,
      };
    });
  }

  private async connect(): Promise<PoolClient> {
    if (!this.pool)
      throw new ServiceUnavailableException(
        'Geodata database is not configured',
      );
    try {
      return await this.pool.connect();
    } catch {
      throw new ServiceUnavailableException('Geodata database is unavailable');
    }
  }
}

function parseAssignmentBody(
  body: Record<string, unknown>,
  forCommit: boolean,
): AssignmentBody & {
  manualAssignments: AssignmentInput[];
  expectedIdentifiers: ExpectedIdentifier[];
} {
  const programmeSlug = requiredText(body.programmeSlug, 'programmeSlug');
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(programmeSlug))
    throw new BadRequestException('programmeSlug is invalid');
  if (!Array.isArray(body.entityIds) || !body.entityIds.length)
    throw new BadRequestException('entityIds must contain at least one entity');
  if (body.entityIds.length > MAX_SYNCHRONOUS_PROGRAMME_ASSIGNMENT)
    throw new BadRequestException(
      `select at most ${MAX_SYNCHRONOUS_PROGRAMME_ASSIGNMENT} entities for one synchronous assignment`,
    );
  const entityIds = body.entityIds.map((id) => {
    if (typeof id !== 'string' || !UUID.test(id))
      throw new BadRequestException('entityIds must contain only UUIDs');
    return id.toLowerCase();
  });
  if (new Set(entityIds).size !== entityIds.length)
    throw new BadRequestException('entityIds must not contain duplicates');
  const manualAssignments = parseManualAssignments(body.manualAssignments);
  const selectedIds = new Set(entityIds);
  if (
    manualAssignments.some((item) => !selectedIds.has(item.entityId)) ||
    new Set(manualAssignments.map((item) => item.entityId)).size !==
      manualAssignments.length
  )
    throw new BadRequestException(
      'manualAssignments must contain at most one entry for each selected entity',
    );
  const expectedIdentifiers = parseExpectedIdentifiers(
    body.expectedIdentifiers,
  );
  if (
    expectedIdentifiers.some((item) => !selectedIds.has(item.entityId)) ||
    new Set(expectedIdentifiers.map((item) => item.entityId)).size !==
      expectedIdentifiers.length
  )
    throw new BadRequestException(
      'expectedIdentifiers must contain at most one entry for each selected entity',
    );
  if (
    forCommit &&
    (expectedIdentifiers.length !== entityIds.length ||
      entityIds.some(
        (entityId) =>
          !expectedIdentifiers.some((item) => item.entityId === entityId),
      ))
  )
    throw new BadRequestException(
      'preview the full selected entity set before confirming assignment',
    );
  return {
    programmeSlug,
    entityIds,
    manualAssignments,
    expectedIdentifiers,
  };
}

function parseManualAssignments(value: unknown): AssignmentInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new BadRequestException('manualAssignments must be an array');
  return value.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.entityId !== 'string' ||
      !UUID.test(item.entityId)
    )
      throw new BadRequestException(
        'manualAssignments contains an invalid entityId',
      );
    const assignment: AssignmentInput = {
      entityId: item.entityId.toLowerCase(),
    };
    if (item.qualifier !== undefined) {
      if (typeof item.qualifier !== 'string')
        throw new BadRequestException(
          'manual assignment qualifier must be text',
        );
      assignment.qualifier = item.qualifier;
    }
    if (item.serial !== undefined) assignment.serial = item.serial;
    return assignment;
  });
}

function parseExpectedIdentifiers(value: unknown): ExpectedIdentifier[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new BadRequestException('expectedIdentifiers must be an array');
  return value.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.entityId !== 'string' ||
      !UUID.test(item.entityId) ||
      typeof item.entityIdentifier !== 'string'
    )
      throw new BadRequestException(
        'expectedIdentifiers contains an invalid item',
      );
    return {
      entityId: item.entityId.toLowerCase(),
      entityIdentifier: item.entityIdentifier,
    };
  });
}

function assignmentFor(
  assignments: AssignmentInput[],
  entityId: string,
): AssignmentInput | undefined {
  return assignments.find((item) => item.entityId === entityId);
}

function entityProperties(entity: AssignmentRow): Record<string, unknown> {
  return {
    ...(isRecord(entity.public_properties) ? entity.public_properties : {}),
    location: entity.location,
  };
}

function assertExpectedIdentifiers(
  proposed: Array<{ entityId: string; entityIdentifier: string }>,
  expected: ExpectedIdentifier[],
) {
  const expectedById = new Map(
    expected.map((item) => [item.entityId, item.entityIdentifier]),
  );
  if (
    proposed.some(
      (item) => expectedById.get(item.entityId) !== item.entityIdentifier,
    )
  )
    throw new ConflictException(
      'programme ID suggestions changed; preview the selection again before assigning',
    );
}

function positiveSerial(value: unknown, width: number): number {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d+$/.test(text))
    throw new BadRequestException(
      'enter a positive numeric serial for each entity',
    );
  const serial = Number(text);
  if (!Number.isSafeInteger(serial) || serial < 1 || serial > 10 ** width - 1)
    throw new BadRequestException(
      `serial number must be between 1 and ${10 ** width - 1}`,
    );
  return serial;
}

function firstUnusedSerial(
  used: Array<{ scope: string; serial: number }>,
  qualifier: string,
): number {
  let serial = 1;
  while (
    used.some(
      (item) => item.serial === serial && scopesConflict(item.scope, qualifier),
    )
  )
    serial += 1;
  return serial;
}

function maxSerial(
  used: Array<{ scope: string; serial: number }>,
  scope: string,
): number {
  return used.reduce(
    (maximum, item) =>
      scope === '' || item.scope === '' || item.scope === scope
        ? Math.max(maximum, item.serial)
        : maximum,
    0,
  );
}

function scopesConflict(existing: string, proposed: string): boolean {
  return existing === '' || proposed === '' || existing === proposed;
}

function counterScopeFor(
  policy: ProgrammeEntityNumberingPolicy,
  qualifier: string,
): string {
  return policy.assignmentMode === 'PROGRAMME_SEQUENCE' ? '' : qualifier;
}

async function lockIdentifierScopes(
  client: PoolClient,
  programmeSlug: string,
  policy: ProgrammeEntityNumberingPolicy,
  entities: AssignmentRow[],
  assignments: AssignmentInput[],
) {
  const scopes = new Set<string>();
  if (
    policy.assignmentMode === 'PROGRAMME_SEQUENCE' ||
    policy.assignmentMode === 'MANUAL'
  ) {
    scopes.add('');
  } else {
    for (const entity of entities) {
      const manual = assignmentFor(assignments, entity.id);
      const suggestion = suggestProgrammeEntityIdentifier(
        { ...policy, assignmentMode: 'MANUAL' },
        entityProperties(entity),
        manual,
        1,
      );
      scopes.add(suggestion.qualifier ?? '');
    }
  }
  for (const scope of [...scopes].sort())
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('geodata:entity-id:' || $1 || ':' || $2,0))",
      [programmeSlug, scope],
    );
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new BadRequestException(`${field} is required`);
  return value.trim();
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
