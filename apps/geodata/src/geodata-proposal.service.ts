import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeAttachmentMetadata } from '@app/geodata-domain';
import { pythonTruthy } from '@app/platform/python-truthiness.js';
import {
  firstPythonTruthy,
  normalizeEntityTypeCodes,
} from './geodata-entity-types.js';
import { GeodataImportService } from './geodata-import.service.js';

@Injectable()
export class GeodataProposalService {
  constructor(private readonly imports: GeodataImportService) {}

  create(
    key: string | undefined,
    proposerId: string,
    body: Record<string, unknown>,
  ) {
    if (!isRecord(body.feature) || !pythonTruthy(body.feature))
      throw new BadRequestException('feature is required');
    const suppliedSource = firstPythonTruthy(body.source);
    if (suppliedSource !== undefined && !isRecord(suppliedSource))
      throw new BadRequestException('source must be an object');
    const source = isRecord(suppliedSource) ? suppliedSource : {};
    const proposalId = randomUUID();
    const feature = { ...body.feature };
    const properties = isRecord(feature.properties)
      ? { ...feature.properties }
      : {};
    const requestEntityTypes = firstPythonTruthy(
      body.entityTypes,
      body.entityTypeCodes,
      body.entityType,
    );
    const propertyEntityTypes = firstPythonTruthy(
      properties.entityTypes,
      properties.entityTypeCodes,
      properties.entityType,
    );
    if (requestEntityTypes && !propertyEntityTypes)
      properties.entityTypes = requestEntityTypes;
    const entityTypes = normalizeEntityTypeCodes(
      firstPythonTruthy(propertyEntityTypes, requestEntityTypes),
    );
    if (!entityTypes.length)
      throw new BadRequestException(
        'entityTypes must contain at least one shared entity category code',
      );
    const requestedAttachments = Object.hasOwn(body, 'attachments')
      ? body.attachments
      : feature.attachments;
    try {
      properties.attachments = normalizeAttachmentMetadata(
        firstPythonTruthy(requestedAttachments, properties.attachments),
      );
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'invalid attachments',
      );
    }
    properties.candidateSource = {
      type: 'COMMUNITY_PROPOSAL',
      proposalId,
      proposerId,
    };
    feature.properties = properties;
    return this.imports.create(
      key ? `http:${proposerId}:/v1/geodata/proposals:${key}` : undefined,
      {
        adapter: 'MANUAL',
        programmeSlug: body.programmeSlug,
        entityTypes,
        source: {
          ...source,
          name: Object.hasOwn(source, 'name') ? source.name : 'Manual proposal',
          license: Object.hasOwn(source, 'license')
            ? source.license
            : 'programme-supplied',
        },
        features: [feature],
      },
      {
        communityProposal: { proposalId, proposerId },
        requestHash: key ? fingerprintRequest(body) : undefined,
      },
    );
  }
}

function fingerprintRequest(body: Record<string, unknown>): string {
  return createHash('sha256').update(pythonSortedJson(body)).digest('hex');
}

function pythonSortedJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string')
    return JSON.stringify(value).replace(
      /[\u007f-\uffff]/g,
      (character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
  if (typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value))
    return `[${value.map(pythonSortedJson).join(', ')}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort(compareCodePoints)
      .map((key) => `${pythonSortedJson(key)}: ${pythonSortedJson(value[key])}`)
      .join(', ')}}`;
  return 'null';
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
  const rightPoints = Array.from(right, (character) =>
    character.codePointAt(0)!,
  );
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index])
      return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
