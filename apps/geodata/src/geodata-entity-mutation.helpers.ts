import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { AccessTokenClaims } from '@app/platform/access-token.js';
import { integerSetting } from '@app/platform/integer-setting.js';
import { pythonFloatString } from '@app/platform/python-number.js';
import { trimPythonWhitespace } from '@app/platform/python-strings.js';
import { unicodeCaseFold } from '@app/platform/unicode-casefold.js';

export const MAX_COORDINATES = integerSetting(
  process.env.GEODATA_MAX_COORDINATES,
  50_000,
);

export const locationColumns: Record<string, string> = {
  continent: 'continent',
  continentCode: 'continent_code',
  country: 'country',
  countryCode: 'country_code',
  region: 'region',
  regionCode: 'region_code',
  subdivision: 'subdivision',
  subdivisionCode: 'subdivision_code',
  province: 'province',
  provinceCode: 'province_code',
  county: 'county',
  countyCode: 'county_code',
  city: 'city',
  municipality: 'municipality',
  locality: 'locality',
};
const providerDerivedLocationFields = new Set([
  'continentCode',
  'countryCode',
  'regionCode',
  'subdivisionCode',
  'provinceCode',
]);
export const manualLocationFields = new Set(
  Object.keys(locationColumns).filter(
    (field) => !providerDerivedLocationFields.has(field),
  ),
);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertReviewCoverage(
  claims: AccessTokenClaims,
  entity: Record<string, unknown>,
) {
  if (claims.scp.includes('*')) return;
  if (!claims.scp.includes('geodata.review'))
    throw new ForbiddenException('geodata.review scope is required');
  const properties = isRecord(entity.public_properties)
    ? entity.public_properties
    : {};
  const rawCategories = firstTruthyCategoryInput([
    properties.entityTypes,
    properties.entityTypeCodes,
    properties.entityType,
    entity.entity_type_codes,
    entity.entity_type_code,
  ]);
  const categories = normalizeEntityTypeCodes(rawCategories);
  const roles = claims.roles ?? [];
  const scopedRoles = roles.filter((role) => {
    const scopes = Array.isArray(role.scopes) ? role.scopes : [];
    return scopes.includes('geodata.review') || role.role === 'GLOBAL_OPERATOR';
  });
  for (const role of scopedRoles) {
    if (role.programmeSlug && role.programmeSlug !== entity.programme_slug)
      continue;
    if (role.entityType) {
      if (
        typeof role.entityType !== 'string' ||
        !categories.includes(role.entityType.toUpperCase())
      )
        continue;
    }
    if (role.jurisdiction && role.jurisdiction !== entity.jurisdiction)
      continue;
    return;
  }
  if (!roles.some((role) => role.role === 'GLOBAL_OPERATOR'))
    throw new ForbiddenException('approver scope does not cover this entity');
}

export function assertGisAdminCoverage(
  claims: AccessTokenClaims,
  entity: Record<string, unknown>,
  permission: string,
) {
  if (claims.scp.includes('*')) return;
  const roles = claims.roles ?? [];
  if (
    roles.some((role) => {
      if (!['GIS_ADMIN', 'GLOBAL_OPERATOR'].includes(String(role.role)))
        return false;
      if (role.programmeSlug && role.programmeSlug !== entity.programme_slug)
        return false;
      if (role.jurisdiction && role.jurisdiction !== entity.jurisdiction)
        return false;
      return true;
    })
  )
    return;
  if (claims.scp.includes(permission)) return;
  throw new ForbiddenException(
    'global or GIS administrator access is required',
  );
}

export function normalizeEntityTypeCodes(value: unknown): string[] {
  let raw = value;
  if (isRecord(raw)) raw = raw.code || raw.entityType;
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? [raw]
      : [];
  const result: string[] = [];
  for (const item of values) {
    const candidate = isRecord(item) ? item.code : item;
    const code =
      typeof candidate === 'string'
        ? trimPythonWhitespace(candidate).toUpperCase()
        : '';
    if (/^[A-Z][A-Z0-9_]{1,63}$/.test(code) && !result.includes(code))
      result.push(code);
  }
  return result;
}

export function firstTruthyCategoryInput(values: unknown[]) {
  return values.find((value) => {
    if (value === null || value === undefined || value === false || value === 0)
      return false;
    if (typeof value === 'string') return value.length > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (isRecord(value)) return Object.keys(value).length > 0;
    return true;
  });
}

export function normalizeManualLocationValue(field: string, value: unknown) {
  if (value === null) return null;
  if (
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    typeof value !== 'boolean'
  )
    throw new BadRequestException(
      `location field ${field} must be scalar or null`,
    );
  const text =
    typeof value === 'boolean'
      ? value
        ? 'True'
        : 'False'
      : typeof value === 'number' && !Number.isInteger(value)
        ? pythonFloatString(value)
        : String(value);
  const normalized = trimPythonWhitespace(text);
  return field.endsWith('Code') ? normalized.toUpperCase() : normalized || null;
}

export function deriveManualLocationCodes(
  location: Record<string, unknown>,
  manual: Set<string>,
  rows: Record<string, unknown>[],
) {
  const continents = buildManualLocationTree(rows);
  const continent = findLocationNode(continents, location.continent);
  const result: Record<string, unknown> = {};
  if (manual.has('continent')) {
    if (!continent)
      throw new BadRequestException(
        'continent must match the location catalogue',
      );
    result.continentCode = continent.code;
  }
  const countries = continent
    ? (continent.countries ?? [])
    : flattenLocationNodes(continents, 'countries');
  const country = findLocationNode(countries, location.country);
  if (manual.has('country')) {
    if (!country)
      throw new BadRequestException(
        'country must match the location catalogue',
      );
    result.countryCode = country.code;
  }
  const subdivisionValue = location.region || location.subdivision;
  const subdivisions = country
    ? (country.subdivisions ?? [])
    : flattenLocationNodes(countries, 'subdivisions');
  const subdivision = findLocationNode(subdivisions, subdivisionValue);
  if (manual.has('region') || manual.has('subdivision')) {
    if (!subdivision)
      throw new BadRequestException(
        'region or subdivision must match the location catalogue',
      );
    result.regionCode = subdivision.code;
    result.subdivisionCode = subdivision.code;
  }
  const provinces = subdivision
    ? (subdivision.provinces ?? [])
    : flattenLocationNodes(subdivisions, 'provinces');
  const province = findLocationNode(provinces, location.province);
  if (manual.has('province')) {
    if (!province)
      throw new BadRequestException(
        'province must match the location catalogue',
      );
    result.provinceCode = province.code;
  }
  return result;
}

type ManualLocationBuilderNode = {
  name: string;
  code: string | null;
  children: Map<string, ManualLocationBuilderNode>;
};

type ManualLocationNode = {
  name: string;
  code: string | null;
  countries?: ManualLocationNode[];
  subdivisions?: ManualLocationNode[];
  provinces?: ManualLocationNode[];
};

function buildManualLocationTree(rows: Record<string, unknown>[]) {
  const continents = new Map<string, ManualLocationBuilderNode>();
  const upsert = (
    nodes: Map<string, ManualLocationBuilderNode>,
    name: unknown,
    code: unknown,
  ) => {
    const label = textValue(name);
    if (!label) return null;
    const normalizedCode = normalizedLocationCode(code);
    const key = `${normalizedCode ?? ''}:${unicodeCaseFold(label)}`;
    let node = nodes.get(key);
    if (!node) {
      node = { name: label, code: normalizedCode, children: new Map() };
      nodes.set(key, node);
    } else if (!node.code && normalizedCode) {
      node.code = normalizedCode;
    }
    return node;
  };
  for (const row of rows) {
    const continent = upsert(continents, row.continent, row.continent_code);
    if (!continent) continue;
    const country = upsert(continent.children, row.country, row.country_code);
    if (!country) continue;
    const subdivision = upsert(country.children, row.region, row.region_code);
    if (!subdivision) continue;
    upsert(subdivision.children, row.province, row.province_code);
  }
  const sorted = (
    nodes: Map<string, ManualLocationBuilderNode>,
    childFields: ('countries' | 'subdivisions' | 'provinces')[],
  ): ManualLocationNode[] =>
    [...nodes.values()]
      .map((node) => {
        const result: ManualLocationNode = { name: node.name, code: node.code };
        const childField = childFields[0];
        if (childField) {
          result[childField] = sorted(node.children, childFields.slice(1));
        }
        return result;
      })
      .sort(
        (left, right) =>
          compareText(
            unicodeCaseFold(left.name),
            unicodeCaseFold(right.name),
          ) || compareText(left.code ?? '', right.code ?? ''),
      );
  return sorted(continents, ['countries', 'subdivisions', 'provinces']);
}

function findLocationNode(nodes: ManualLocationNode[], name: unknown) {
  const target = unicodeCaseFold(textValue(name));
  return target
    ? nodes.find((node) => unicodeCaseFold(node.name) === target)
    : undefined;
}

function flattenLocationNodes(
  nodes: ManualLocationNode[],
  childField: 'countries' | 'subdivisions' | 'provinces',
): ManualLocationNode[] {
  return nodes.flatMap((node) => {
    const children = node[childField] ?? [];
    return childField === 'provinces'
      ? children
      : [
          ...children,
          ...flattenLocationNodes(
            children,
            childField === 'countries' ? 'subdivisions' : 'provinces',
          ),
        ];
  });
}

function textValue(value: unknown) {
  return typeof value === 'string' ? trimPythonWhitespace(value) : '';
}

function normalizedLocationCode(value: unknown) {
  const code = textValue(value).toUpperCase();
  return code || null;
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parseIfMatch(value: string | undefined) {
  if (value === undefined) return null;
  const match = /^"([0-9]+)"$/.exec(value);
  if (!match)
    throw new BadRequestException('If-Match must be a quoted entity version');
  return Number(match[1]);
}

export function normalizeWebsite(value: unknown) {
  if (value === null) return null;
  if (typeof value !== 'string')
    throw new BadRequestException('website must be a string or null');
  const website = trimPythonWhitespace(value);
  if (!website) return null;
  if (Array.from(website).length > 2048)
    throw new BadRequestException('website must be 2048 characters or fewer');
  let parsed: URL;
  try {
    parsed = new URL(website);
  } catch {
    throw new BadRequestException(
      'website must be an absolute HTTP or HTTPS URL',
    );
  }
  const authority =
    website.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1] ?? '';
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    authority.includes('@')
  )
    throw new BadRequestException(
      'website must be an absolute HTTP or HTTPS URL',
    );
  return website;
}

export function normalizeDescription(value: unknown) {
  if (value === null) return null;
  if (typeof value !== 'string')
    throw new BadRequestException('description must be a string or null');
  const description = trimPythonWhitespace(value);
  if (Array.from(description).length > 2000)
    throw new BadRequestException(
      'description must be 2000 characters or fewer',
    );
  return description || null;
}

export function titleCode(code: string) {
  return code
    .replaceAll('_', ' ')
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
