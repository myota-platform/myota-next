import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { normalizeAttachmentMetadata } from '@app/geodata-domain';
import { pythonTruthy } from '@app/platform/python-truthiness.js';
import { fingerprintJsonRequest } from './geodata-request-fingerprint.js';
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
    rawBody?: string,
  ) {
    const idempotencyKey = key
      ? `http:${proposerId}:/v1/geodata/proposals:${key}`
      : undefined;
    const requestHash = key ? fingerprintJsonRequest(body, rawBody) : undefined;
    const proposalId = randomUUID();
    return this.imports.create(
      idempotencyKey,
      () => {
        if (!isRecord(body.feature) || !pythonTruthy(body.feature))
          throw new BadRequestException('feature is required');
        const suppliedSource = firstPythonTruthy(body.source);
        if (suppliedSource !== undefined && !isRecord(suppliedSource))
          throw new BadRequestException('source must be an object');
        const source = isRecord(suppliedSource) ? suppliedSource : {};
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
        return {
          adapter: 'MANUAL',
          programmeSlug: body.programmeSlug,
          entityTypes,
          source: {
            ...source,
            name: Object.hasOwn(source, 'name')
              ? source.name
              : 'Manual proposal',
            license: Object.hasOwn(source, 'license')
              ? source.license
              : 'programme-supplied',
          },
          features: [feature],
        };
      },
      {
        communityProposal: { proposalId, proposerId },
        requestHash,
      },
    );
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
