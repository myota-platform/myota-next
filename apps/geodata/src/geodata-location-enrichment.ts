import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import { createHash, randomUUID } from 'node:crypto';

const requiredGroups = [
  ['continent'],
  ['continentCode'],
  ['country'],
  ['countryCode'],
  ['region', 'subdivision'],
  ['regionCode', 'subdivisionCode'],
  ['city', 'municipality'],
];

export function missingLocationFields(
  location: Record<string, unknown>,
  manualFields: unknown,
) {
  const manual = Array.isArray(manualFields)
    ? manualFields.filter((field): field is string => typeof field === 'string')
    : [];
  return requiredGroups
    .filter(
      (group) =>
        !group.some(
          (field) => location[field] != null && location[field] !== '',
        ) && !group.some((field) => manual.includes(field)),
    )
    .map((group) => group[0]);
}

export function queueLocationEnrichment(
  entityId: string,
  properties: Record<string, unknown>,
  geometry: unknown,
  location: Record<string, unknown>,
  manualFields: unknown,
  reason: string,
  requestedBy: unknown,
  onlyMissing: boolean,
  requestedAt = new Date().toISOString(),
) {
  if (!isRecord(geometry)) return undefined;
  if (onlyMissing && !missingLocationFields(location, manualFields).length)
    return undefined;
  const geometryHash = createHash('sha256')
    .update(stringifyJsonWithBigInts(geometry))
    .digest('hex');
  if (
    properties.locationEnrichmentStatus === 'QUEUED' &&
    properties.locationEnrichmentGeometryHash === geometryHash
  )
    return undefined;
  const requestId = randomUUID();
  const nextProperties: Record<string, unknown> = {
    ...properties,
    locationEnrichmentRequestId: requestId,
    locationEnrichmentGeometryHash: geometryHash,
    locationEnrichmentStatus: 'QUEUED',
    locationEnrichmentOnlyMissing: onlyMissing,
    locationEnrichmentReason: reason,
    locationEnrichmentRequestedAt: requestedAt,
    locationEnrichmentRequestedBy: requestedBy,
  };
  delete nextProperties.locationEnrichmentError;
  return {
    properties: nextProperties,
    requestedAt,
    event: {
      entityId,
      requestId,
      geometryHash,
      onlyMissing,
      reason,
      requestedBy,
      natsSubject: 'myota.geodata.entity.location-enrichment.v1',
    },
  };
}

export function locationSnapshot(row: Record<string, unknown>) {
  return {
    continent: row.continent,
    continentCode: row.continent_code,
    country: row.country,
    countryCode: row.country_code,
    region: row.region,
    regionCode: row.region_code,
    subdivision: row.subdivision,
    subdivisionCode: row.subdivision_code,
    province: row.province,
    provinceCode: row.province_code,
    county: row.county,
    countyCode: row.county_code,
    city: row.city,
    municipality: row.municipality,
    locality: row.locality,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
