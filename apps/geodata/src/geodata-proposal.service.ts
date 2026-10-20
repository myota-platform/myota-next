import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { GeodataImportService } from './geodata-import.service.js';

const maxAttachments = 20;
const maxAttachmentBytes = 25 * 1024 * 1024;

@Injectable()
export class GeodataProposalService {
  constructor(private readonly imports: GeodataImportService) {}

  create(
    key: string | undefined,
    proposerId: string,
    body: Record<string, unknown>,
  ) {
    if (!isRecord(body.feature) || body.feature.type !== 'Feature')
      throw new BadRequestException('feature must be a GeoJSON Feature');
    if (
      body.source !== undefined &&
      (!isRecord(body.source) || Array.isArray(body.source))
    )
      throw new BadRequestException('source must be an object');
    const source = isRecord(body.source) ? body.source : {};
    const proposalId = randomUUID();
    const feature = { ...body.feature };
    const properties = isRecord(feature.properties)
      ? { ...feature.properties }
      : {};
    properties.attachments = normalizeAttachments(
      firstTruthy(
        body.attachments,
        feature.attachments,
        properties.attachments,
      ),
    );
    properties.sourceRef = `community-proposal:${proposalId}`;
    feature.properties = properties;
    return this.imports.create(
      key ? `proposal:${proposerId}:${key}` : undefined,
      {
        adapter: 'MANUAL',
        programmeSlug: body.programmeSlug,
        entityTypes:
          body.entityTypes ?? body.entityTypeCodes ?? body.entityType,
        source: {
          ...source,
          name:
            typeof source.name === 'string' ? source.name : 'Manual proposal',
          license:
            typeof source.license === 'string'
              ? source.license
              : 'programme-supplied',
          type: 'COMMUNITY_PROPOSAL',
          proposalId,
          proposerId,
        },
        features: [feature],
      },
      { communityProposal: { proposalId, proposerId } },
    );
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstTruthy(...values: unknown[]) {
  return values.find((value) => truthy(value));
}

function normalizeAttachments(value: unknown) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maxAttachments)
    throw new BadRequestException(
      `attachments must be a list of at most ${maxAttachments} metadata records`,
    );
  return value.map((attachment) => {
    if (
      !isRecord(attachment) ||
      !truthy(attachment.name) ||
      !truthy(attachment.mediaType)
    )
      throw new BadRequestException(
        'each attachment requires name and mediaType',
      );
    const sizeBytes = parseAttachmentSize(attachment.sizeBytes);
    if (sizeBytes < 0 || sizeBytes > maxAttachmentBytes)
      throw new BadRequestException(
        `attachment size must be between 0 and ${maxAttachmentBytes} bytes`,
      );
    if (!truthy(attachment.uri) && !truthy(attachment.sha256))
      throw new BadRequestException(
        'each attachment requires a URI or sha256 content reference',
      );
    return {
      name: String(attachment.name),
      mediaType: String(attachment.mediaType),
      sizeBytes,
      uri: attachment.uri,
      sha256: attachment.sha256,
      license: attachment.license,
      caption: attachment.caption,
    };
  });
}

function parseAttachmentSize(value: unknown) {
  if (!truthy(value)) return 0;
  if (typeof value === 'boolean') return Number(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return Math.trunc(value);
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new BadRequestException('attachment sizeBytes must be an integer');
}

function truthy(value: unknown) {
  if (value == null || value === false || value === 0 || value === '')
    return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}
