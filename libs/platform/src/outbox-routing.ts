import { readFile } from 'node:fs/promises';

type Route = {
  subject: string;
  stream?: string;
  producers: string[];
  workType?: string;
  workIdField?: string;
  payloadFields?: string[];
};

type Registry = {
  events: Array<{ eventType: string; owner: string; subject: string }>;
  work: Array<{
    workType: string;
    subject: string;
    stream: string;
    durable: string;
    owner: string;
  }>;
  producerNamesByOwner: Record<string, string[]>;
  legacyWorkRoutes: Record<string, Route>;
  targetWorkRoutes: Record<string, Route>;
};

export type ClaimedOutboxEvent = {
  eventId: string;
  eventType: string;
  producer: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  correlationId: string | null;
};

export type RoutedOutboxEvent = {
  subject: string;
  stream: string;
  envelope: Record<string, unknown>;
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function loadOutboxRegistry(): Promise<Registry> {
  const path =
    process.env.MYOTA_EVENT_REGISTRY ??
    `${process.cwd()}/contracts/event-registry.json`;
  return JSON.parse(await readFile(path, 'utf8')) as Registry;
}

export function routeOutboxEvent(
  row: ClaimedOutboxEvent,
  registry: Registry,
  owner: string,
): RoutedOutboxEvent {
  if (!UUID.test(row.eventId))
    throw new OutboxContractError('outbox event ID must be a UUID');
  if (
    !row.payload ||
    typeof row.payload !== 'object' ||
    Array.isArray(row.payload)
  ) {
    throw new OutboxContractError('outbox payload must be an object');
  }
  if (!row.producer || !row.aggregateType || row.aggregateId == null) {
    throw new OutboxContractError('producer and aggregate are required');
  }
  if (
    !(row.occurredAt instanceof Date) ||
    Number.isNaN(row.occurredAt.valueOf())
  ) {
    throw new OutboxContractError('outbox timestamp must be valid');
  }
  if (
    row.correlationId !== null &&
    (row.correlationId.length < 1 ||
      row.correlationId.length > 128 ||
      /[^\x21-\x7e]/.test(row.correlationId))
  ) {
    throw new OutboxContractError(
      'correlation ID must be bounded printable text',
    );
  }

  const fact = registry.events.find(
    (event) => event.eventType === row.eventType,
  );
  const work = registry.work.find((item) => item.workType === row.eventType);
  const legacy = registry.legacyWorkRoutes[row.eventType];
  const targetType = legacy?.workType ?? row.eventType;
  const target = registry.targetWorkRoutes[targetType];
  const factProducers = fact
    ? registry.producerNamesByOwner[fact.owner]
    : undefined;
  const expectedProducers =
    legacy?.producers ?? target?.producers ?? factProducers;
  const registryOwner =
    fact?.owner ??
    work?.owner ??
    (targetType.startsWith('activity.')
      ? 'activity-service'
      : targetType.startsWith('geodata.')
        ? 'geodata-service'
        : 'identity-service');
  const expectedOwner =
    registryOwner === 'activity-service'
      ? 'activity'
      : registryOwner === 'geodata-service'
        ? 'geodata'
        : 'core';
  if (!expectedProducers || (!fact && !work && !legacy && !target)) {
    throw new OutboxContractError('unregistered outbox event type');
  }
  if (expectedOwner !== owner)
    throw new OutboxContractError(
      'outbox event belongs to another database owner',
    );
  if (!expectedProducers.includes(row.producer))
    throw new OutboxContractError(
      'producer does not match registered event owner',
    );

  const occurredAt = row.occurredAt.toISOString();
  const correlation = row.correlationId ?? undefined;
  if (target) {
    if (row.payload.natsSubject !== undefined) {
      if (!legacy || row.payload.natsSubject !== legacy.subject) {
        throw new OutboxContractError(
          'registered work subject cannot be overridden',
        );
      }
    }
    const payload: Record<string, unknown> = {};
    if (legacy) {
      for (const field of legacy.payloadFields ?? []) {
        const value =
          row.payload[field] ??
          (field === legacy.workIdField ? row.aggregateId : undefined);
        if (value === undefined || value === null)
          throw new OutboxContractError(`work payload is missing ${field}`);
        payload[field] = value;
      }
    } else {
      Object.assign(payload, row.payload);
    }
    const idField =
      legacy?.workIdField ??
      ['jobId', 'importRunId', 'queueId', 'requestId'].find(
        (field) => typeof payload[field] === 'string',
      );
    const workId = idField ? payload[idField] : undefined;
    if (typeof workId !== 'string' || !UUID.test(workId))
      throw new OutboxContractError('work payload must carry a UUID work ID');
    if (idField !== 'requestId' && workId !== String(row.aggregateId))
      throw new OutboxContractError('work ID must match aggregate ID');
    if (idField) payload[idField] = workId.toLowerCase();
    return {
      subject: target.subject,
      stream:
        target.stream ??
        registry.work.find((item) => item.workType === targetType)?.stream ??
        '',
      envelope: {
        envelopeVersion: 1,
        workId: workId.toLowerCase(),
        workType: targetType,
        createdAt: occurredAt,
        producer: row.producer,
        causationId: row.eventId,
        aggregate: { type: row.aggregateType, id: String(row.aggregateId) },
        payload,
        ...(correlation ? { correlationId: correlation } : {}),
      },
    };
  }

  if (row.payload.natsSubject !== undefined)
    throw new OutboxContractError(
      'domain fact cannot override its registered subject',
    );
  const subject = fact?.subject;
  if (!subject) throw new OutboxContractError('registered subject is missing');
  return {
    subject,
    stream: 'MYOTA_EVENTS',
    envelope: {
      envelopeVersion: 1,
      eventId: row.eventId.toLowerCase(),
      eventType: row.eventType,
      occurredAt,
      producer: row.producer,
      aggregate: { type: row.aggregateType, id: String(row.aggregateId) },
      payload: row.payload,
      ...(correlation ? { correlationId: correlation } : {}),
    },
  };
}

export class OutboxContractError extends Error {}
