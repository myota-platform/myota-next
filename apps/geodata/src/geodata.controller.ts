import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Query,
} from '@nestjs/common';
import { verifyAccessToken } from '@app/platform/access-token.js';
import { GeodataRepository } from './geodata.repository.js';

@Controller('geodata')
export class GeodataController {
  constructor(private readonly repository: GeodataRepository) {}

  @Get('imports')
  listImports(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: Record<string, unknown>,
  ) {
    authorizeImport(authorization);
    return this.repository.listImports(query);
  }

  @Get('imports/:runId')
  getImport(
    @Headers('authorization') authorization: string | undefined,
    @Param('runId') id: string,
  ) {
    authorizeImport(authorization);
    return this.repository.getImport(id);
  }

  @Get('entities')
  listEntities(@Query() query: Record<string, unknown>) {
    return this.repository.listEntities(query);
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

  @Get('location-options')
  async locationOptions(
    @Headers('authorization') authorization: string | undefined,
  ) {
    authorizeBearer(authorization);
    return buildLocationTree(await this.repository.getLocationRows());
  }

  @Get('entities/:entityId')
  getEntity(@Param('entityId') id: string) {
    return this.repository.getEntity(id);
  }
}

function authorizeBearer(authorization: string | undefined) {
  verifyAccessToken(authorization);
}

function authorizeImport(authorization: string | undefined) {
  const claims = verifyAccessToken(authorization);
  if (!claims.scp.some((scope) => scope === '*' || scope === 'geodata.import'))
    throw new ForbiddenException('geodata.import scope is required');
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
    const label = String(name ?? '').trim();
    if (!label) return null;
    const normalizedCode =
      String(code ?? '')
        .trim()
        .toUpperCase() || null;
    const key = `${normalizedCode ?? ''}:${label.toLocaleLowerCase()}`;
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
      .sort((a, b) =>
        String(a.name).localeCompare(String(b.name), undefined, {
          sensitivity: 'base',
        }),
      );
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
