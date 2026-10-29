import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { verifyAccessToken } from '@app/platform/access-token.js';
import { normalizePythonNumericText } from '@app/platform/python-numeric.js';
import { trimPythonWhitespace } from '@app/platform/python-strings.js';
import { unicodeCaseFold } from '@app/platform/unicode-casefold.js';
import { GeodataRepository } from './geodata.repository.js';
import { GeodataImportMutationRepository } from './geodata-import-mutation.repository.js';
import { GeodataEntityMutationRepository } from './geodata-entity-mutation.repository.js';
import {
  authorizeBearer,
  scopedRequestIdempotency,
} from './geodata-controller-support.js';

@Controller('geodata')
export class GeodataController {
  constructor(
    private readonly repository: GeodataRepository,
    private readonly importMutations: GeodataImportMutationRepository,
    private readonly entityMutations: GeodataEntityMutationRepository,
  ) {}

  @Get('entities')
  listEntities(@Query() query: Record<string, unknown>) {
    return this.repository.listEntities(query);
  }

  @Post('entity-id-preview')
  @HttpCode(200)
  previewEntityIdentifier(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    const claims = verifyAccessToken(authorization);
    return this.entityMutations.previewEntityIdentifier(body, claims);
  }

  @Post('entity-programme-assignment-preview')
  @HttpCode(200)
  previewProgrammeEntityAssignment(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    const claims = verifyAccessToken(authorization);
    return this.entityMutations.previewProgrammeEntityAssignment(body, claims);
  }

  @Post('entity-programme-assignments')
  @HttpCode(200)
  assignProgrammeEntities(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: Request,
    @Body() body: Record<string, unknown>,
  ) {
    const claims = verifyAccessToken(authorization);
    const idempotency = scopedRequestIdempotency(
      key,
      claims.sub,
      request,
      body,
    );
    return this.entityMutations.assignProgrammeEntities(
      idempotency.key,
      body,
      claims,
      idempotency.requestHash,
    );
  }

  @Post('entities')
  @HttpCode(201)
  createEntity(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: Request,
    @Body() body: Record<string, unknown>,
  ) {
    const claims = verifyAccessToken(authorization);
    const idempotency = scopedRequestIdempotency(
      key,
      claims.sub,
      request,
      body,
    );
    return this.entityMutations.createEntity(
      idempotency.key,
      body,
      claims,
      idempotency.requestHash,
    );
  }

  @Get('entities/:entityId/audit')
  getEntityAudit(
    @Headers('authorization') authorization: string | undefined,
    @Param('entityId') id: string,
  ) {
    authorizeBearer(authorization);
    return this.repository.getEntityAudit(id);
  }

  @Get('adapters')
  adapters(@Headers('authorization') authorization: string | undefined) {
    authorizeBearer(authorization);
    return {
      adapters: [
        {
          code: 'PARKSERVE_US',
          formats: ['PARKSERVE_US', 'GEOJSON', 'KML', 'GPX'],
          requires: ['license', 'retrievedAt', 'sourceRef'],
        },
        {
          code: 'OSM',
          formats: ['OSM_PBF', 'GEOJSON', 'KML', 'GPX'],
          requiredTags: [
            'leisure=park',
            'leisure=nature_reserve',
            'boundary=protected_area',
            'landuse=recreation_ground',
            'highway=path',
            'highway=footway',
            'highway=track',
            'highway=bridleway',
            'route=hiking',
          ],
          attribution: '© OpenStreetMap contributors',
        },
        {
          code: 'GOVERNMENT_GIS',
          formats: [
            'WFS',
            'GEOJSON',
            'KML',
            'GPX',
            'SHAPEFILE',
            'SHP',
            'ARCGIS_FEATURESERVER',
          ],
          requires: ['license', 'attribution', 'sourceFormat'],
        },
        {
          code: 'MANUAL',
          formats: ['GEOJSON', 'KML', 'GPX', 'SHAPEFILE', 'SHP'],
          requires: ['feature', 'entityTypes'],
        },
      ],
    };
  }

  @Get('conflation')
  listConflation(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: Record<string, unknown>,
  ) {
    authorizeBearer(authorization);
    return this.repository.listConflation(query);
  }

  @Post('conflation/:candidateId/resolve')
  @HttpCode(200)
  resolveConflation(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('candidateId') candidateId: string,
    @Body() body: Record<string, unknown>,
    @Req() request: Request,
  ) {
    const claims = verifyAccessToken(authorization);
    const idempotency = scopedRequestIdempotency(
      key,
      claims.sub,
      request,
      body,
    );
    return this.importMutations.resolveConflation(
      candidateId,
      idempotency.key,
      body,
      idempotency.requestHash,
    );
  }

  @Get('location-options')
  async locationOptions(
    @Headers('authorization') authorization: string | undefined,
  ) {
    authorizeBearer(authorization);
    return buildLocationTree(await this.repository.getLocationRows());
  }

  @Get('tiles/:z/:x/:y')
  async tile(
    @Param('z') zoom: string,
    @Param('x') x: string,
    @Param('y') y: string,
  ) {
    const coordinates = parseTileCoordinates(zoom, x, y);
    return this.repository.getTile(...coordinates);
  }

  @Get('entities/:entityId')
  getEntity(@Param('entityId') id: string) {
    return this.repository.getEntity(id);
  }

  @Patch('entities/:entityId')
  patchEntityMetadata(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Headers('if-match') ifMatch: string | undefined,
    @Param('entityId') id: string,
    @Body() body: Record<string, unknown>,
    @Req() request: Request,
  ) {
    const claims = verifyAccessToken(authorization);
    const idempotency = scopedRequestIdempotency(
      key,
      claims.sub,
      request,
      body,
    );
    return this.entityMutations.patchEntityMetadata(
      id,
      idempotency.key,
      ifMatch,
      body,
      claims,
      idempotency.requestHash,
    );
  }

  @Post('entities/:entityId/location-enrichment-requests')
  @HttpCode(202)
  requestLocationEnrichment(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Headers('if-match') ifMatch: string | undefined,
    @Param('entityId') id: string,
    @Body() body: Record<string, unknown>,
    @Req() request: Request,
  ) {
    const claims = verifyAccessToken(authorization);
    const idempotency = scopedRequestIdempotency(
      key,
      claims.sub,
      request,
      body,
    );
    return this.entityMutations.requestLocationEnrichment(
      id,
      idempotency.key,
      ifMatch,
      body,
      claims,
      idempotency.requestHash,
    );
  }

  @Post('entities/:entityId/reviews')
  @HttpCode(200)
  reviewEntity(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Headers('if-match') ifMatch: string | undefined,
    @Param('entityId') id: string,
    @Body() body: Record<string, unknown>,
    @Req() request: Request,
  ) {
    const claims = verifyAccessToken(authorization);
    const idempotency = scopedRequestIdempotency(
      key,
      claims.sub,
      request,
      body,
    );
    return this.entityMutations.reviewEntity(
      id,
      idempotency.key,
      ifMatch,
      body,
      claims,
      idempotency.requestHash,
    );
  }

  @Put('entities/:entityId/categories')
  replaceEntityCategories(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Headers('if-match') ifMatch: string | undefined,
    @Param('entityId') id: string,
    @Body() body: Record<string, unknown>,
    @Req() request: Request,
  ) {
    const claims = verifyAccessToken(authorization);
    const idempotency = scopedRequestIdempotency(
      key,
      claims.sub,
      request,
      body,
    );
    return this.entityMutations.replaceEntityCategories(
      id,
      idempotency.key,
      ifMatch,
      body,
      claims,
      idempotency.requestHash,
    );
  }

  @Put('entities/:entityId/geometry')
  replaceEntityGeometry(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Headers('if-match') ifMatch: string | undefined,
    @Param('entityId') id: string,
    @Body() body: Record<string, unknown>,
    @Req() request: Request,
  ) {
    const claims = verifyAccessToken(authorization);
    const idempotency = scopedRequestIdempotency(
      key,
      claims.sub,
      request,
      body,
    );
    return this.entityMutations.replaceEntityGeometry(
      id,
      idempotency.key,
      ifMatch,
      body,
      claims,
      idempotency.requestHash,
    );
  }
}

function parseTileCoordinates(
  zoomText: string,
  xText: string,
  yText: string,
): [number, number, number] {
  const values = [zoomText, xText, yText].map((value) => {
    const normalized = normalizePythonNumericText(value);
    if (!/^[+-]?\d(?:_?\d)*$/.test(normalized))
      throw new BadRequestException('tile coordinates must be integers');
    return BigInt(normalized.replaceAll('_', ''));
  });
  const [zoom, x, y] = values;
  if (
    zoom < 0n ||
    zoom > 22n ||
    x < 0n ||
    y < 0n ||
    x >= 1n << zoom ||
    y >= 1n << zoom
  )
    throw new BadRequestException('invalid Web Mercator tile coordinates');
  return [Number(zoom), Number(x), Number(y)];
}

type LocationNode = { name: string; code: string | null } & Record<string, any>;

function buildLocationTree(rows: Record<string, string | null>[]) {
  const continents = new Map<string, LocationNode>();
  const upsert = (
    map: Map<string, LocationNode>,
    name: string | null,
    code: string | null,
    childFields: string[],
  ) => {
    const label = trimPythonWhitespace(String(name ?? ''));
    if (!label) return null;
    const normalizedCode =
      trimPythonWhitespace(String(code ?? '')).toUpperCase() || null;
    const key = `${normalizedCode ?? ''}:${unicodeCaseFold(label)}`;
    let value = map.get(key);
    if (!value) {
      value = { name: label, code: normalizedCode };
      for (const field of childFields) value[field] = new Map();
      map.set(key, value);
    } else if (!value.code && normalizedCode) value.code = normalizedCode;
    return value;
  };
  const cities = (
    map: Map<string, LocationNode>,
    row: Record<string, string | null>,
  ) => {
    for (const name of new Set([row.city, row.municipality].filter(Boolean)))
      upsert(map, name, null, []);
  };
  for (const row of rows) {
    const continent = upsert(continents, row.continent, row.continentCode, [
      'countries',
    ]);
    if (!continent) continue;
    const country = upsert(
      continent.countries as Map<string, LocationNode>,
      row.country,
      row.countryCode,
      ['subdivisions', 'cities'],
    );
    if (!country) continue;
    cities(country.cities as Map<string, LocationNode>, row);
    const subdivision = upsert(
      country.subdivisions as Map<string, LocationNode>,
      row.region,
      row.regionCode,
      ['provinces', 'cities'],
    );
    if (!subdivision) continue;
    cities(subdivision.cities as Map<string, LocationNode>, row);
    const province = upsert(
      subdivision.provinces as Map<string, LocationNode>,
      row.province,
      row.provinceCode,
      ['cities'],
    );
    if (province) cities(province.cities as Map<string, LocationNode>, row);
  }
  const sorted = (map: Map<string, LocationNode>, type: string) =>
    [...map.values()]
      .map((node) => {
        const result: Record<string, unknown> = {
          name: node.name,
          code: node.code,
        };
        if (type === 'continent')
          result.countries = sorted(
            node.countries as Map<string, LocationNode>,
            'country',
          );
        if (type === 'country') {
          result.subdivisions = sorted(
            node.subdivisions as Map<string, LocationNode>,
            'subdivision',
          );
          result.cities = sorted(
            node.cities as Map<string, LocationNode>,
            'city',
          );
        }
        if (type === 'subdivision') {
          result.provinces = sorted(
            node.provinces as Map<string, LocationNode>,
            'province',
          );
          result.cities = sorted(
            node.cities as Map<string, LocationNode>,
            'city',
          );
        }
        if (type === 'province')
          result.cities = sorted(
            node.cities as Map<string, LocationNode>,
            'city',
          );
        return result;
      })
      .sort((a, b) => {
        const nameOrder = compareText(
          unicodeCaseFold(String(a.name)),
          unicodeCaseFold(String(b.name)),
        );
        return (
          nameOrder ||
          compareText(
            typeof a.code === 'string' ? a.code : '',
            typeof b.code === 'string' ? b.code : '',
          )
        );
      });
  return {
    provider: 'BIGDATACLOUD',
    codeStandards: {
      continent: 'provider ISO continent code',
      country: 'ISO 3166-1',
      subdivision: 'ISO 3166-2',
    },
    continents: sorted(continents, 'continent'),
  };
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
