import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { GeodataImportService } from './geodata-import.service.js';

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
