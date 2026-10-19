import proj4 from 'proj4';
import { inferFeatureName } from './geodata-feature-name.js';

const OSM_REQUIRED_TAGS = [
  ['leisure', 'park'],
  ['leisure', 'nature_reserve'],
  ['boundary', 'protected_area'],
  ['landuse', 'recreation_ground'],
  ['highway', 'path'],
  ['highway', 'footway'],
  ['highway', 'track'],
  ['highway', 'bridleway'],
  ['route', 'hiking'],
] as const;
const GOVERNMENT_GIS_FORMATS = new Set([
  'GEOJSON',
  'WFS',
  'SHAPEFILE',
  'ARCGIS_FEATURESERVER',
]);

export interface NormalizedAdapterFeature {
  properties: Record<string, unknown>;
  geometry: Record<string, unknown> | null;
  skipReason?: string;
}

export function normalizeAdapterFeature(
  adapter: string,
  feature: Record<string, unknown>,
): NormalizedAdapterFeature {
  if (adapter === 'GOVERNMENT_GIS') return normalizeGovernmentFeature(feature);

  const way =
    typeof feature.type === 'string' && feature.type.toLowerCase() === 'way';
  const rawProperties = isTruthy(feature.properties)
    ? feature.properties
    : feature.tags;
  const properties = isRecord(rawProperties) ? { ...rawProperties } : {};
  if (way) {
    if (!Object.hasOwn(properties, 'featureType'))
      properties.featureType = 'way';
    if (feature.id != null && !Object.hasOwn(properties, 'id'))
      properties.id = feature.id;
  }
  ensureFeatureName(properties);
  let rawGeometry = feature.geometry;
  if (!isTruthy(rawGeometry) && way && feature.coordinates != null) {
    rawGeometry = { type: 'LineString', coordinates: feature.coordinates };
  }
  const geometry = isTruthy(rawGeometry)
    ? normalizeGeometry(
        rawGeometry,
        feature.crs ?? feature.spatialReference ?? properties.crs,
      )
    : null;

  if (adapter === 'PARKSERVE_US') {
    if (!Object.hasOwn(properties, 'sourceRef'))
      properties.sourceRef =
        properties.parkserve_id || properties.park_id || properties.id;
    if (!Object.hasOwn(properties, 'sourceRecordType'))
      properties.sourceRecordType = 'ParkServe US protected/open-space record';
  } else if (adapter === 'OSM') {
    const tags = Object.hasOwn(properties, 'tags')
      ? isRecord(properties.tags)
        ? properties.tags
        : (() => {
            throw new Error('OSM tags must be an object');
          })()
      : properties;
    properties.tags = tags;
    if (!Object.hasOwn(properties, 'sourceRef'))
      properties.sourceRef = properties.osm_id || properties.id;
    if (!Object.hasOwn(properties, 'attribution'))
      properties.attribution = '© OpenStreetMap contributors';
    properties.sourceUrl = properties.sourceUrl || properties.osm_url;
    const matchesRequiredTag = OSM_REQUIRED_TAGS.some(
      ([key, value]) => tags[key] === value,
    );
    properties.matchesRequiredTag = matchesRequiredTag;
    if (!matchesRequiredTag) properties.skipReason = 'FILTERED_TAG';
  }
  return { properties, geometry };
}

function normalizeGovernmentFeature(
  feature: Record<string, unknown>,
): NormalizedAdapterFeature {
  const properties =
    isTruthy(feature.properties) && isRecord(feature.properties)
      ? { ...feature.properties }
      : {};
  const sourceFormat = String(
    properties.sourceFormat || properties.format || 'GEOJSON',
  ).toUpperCase();
  if (!GOVERNMENT_GIS_FORMATS.has(sourceFormat)) {
    throw new Error(`unsupported government GIS format ${sourceFormat}`);
  }
  let rawGeometry = feature.geometry;
  if (sourceFormat === 'ARCGIS_FEATURESERVER' && isRecord(rawGeometry)) {
    if (Object.hasOwn(rawGeometry, 'rings')) {
      rawGeometry = {
        type: 'Polygon',
        coordinates: rawGeometry.rings,
      };
    } else if (
      Object.hasOwn(rawGeometry, 'x') &&
      Object.hasOwn(rawGeometry, 'y')
    ) {
      rawGeometry = {
        type: 'Point',
        coordinates: [rawGeometry.x, rawGeometry.y],
      };
    }
  }
  const geometry = isTruthy(rawGeometry)
    ? normalizeGeometry(
        rawGeometry,
        feature.crs ?? feature.spatialReference ?? properties.crs,
      )
    : null;
  properties.sourceFormat = sourceFormat;
  if (!Object.hasOwn(properties, 'sourceRef'))
    properties.sourceRef =
      properties.objectId || properties.OBJECTID || properties.id;
  if (!Object.hasOwn(properties, 'sourceRecordType'))
    properties.sourceRecordType = 'local-government GIS feature';
  ensureFeatureName(properties);
  return { properties, geometry };
}

function ensureFeatureName(properties: Record<string, unknown>) {
  if (usableName(properties.name)) return;
  const inferred = inferFeatureName(properties);
  if (inferred) properties.name = inferred;
}

function usableName(value: unknown) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().replace(/\s+/g, ' ').toLowerCase();
  return !new Set([
    '',
    '-',
    '--',
    'n/a',
    'na',
    'none',
    'null',
    'unknown',
    'unnamed',
  ]).has(normalized);
}

function normalizeGeometry(value: unknown, crs: unknown) {
  if (!isRecord(value)) throw new Error('geometry must be an object');
  const rawType = String(value.type || '');
  const aliases: Record<string, string> = {
    way: 'LineString',
    linestring: 'LineString',
    multilinestring: 'MultiLineString',
  };
  const type = aliases[rawType.toLowerCase()] ?? rawType;
  if (
    ![
      'Point',
      'LineString',
      'MultiLineString',
      'Polygon',
      'MultiPolygon',
    ].includes(type)
  ) {
    throw new Error(
      'geometry must be a GeoJSON Point, LineString, MultiLineString, Polygon, or MultiPolygon',
    );
  }
  const coordinates = normalizeCoordinates(value.coordinates, sourceCrs(crs));
  return { type, coordinates };
}

function normalizeCoordinates(value: unknown, source: string): unknown {
  if (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number'
  ) {
    if (source === 'EPSG:4326' || source === 'CRS84') return value;
    const [longitude, latitude] = proj4(source, 'EPSG:4326', [
      value[0],
      value[1],
    ]);
    return [longitude, latitude, ...value.slice(2)];
  }
  if (Array.isArray(value))
    return value.map((child) => normalizeCoordinates(child, source));
  return value;
}

function sourceCrs(value: unknown): string {
  if (value == null || value === '') return 'EPSG:4326';
  if (isRecord(value)) {
    const properties = isRecord(value.properties) ? value.properties : {};
    value =
      value.name ??
      value.href ??
      value.wkid ??
      value.latestWkid ??
      properties.name ??
      properties.href ??
      properties.wkid ??
      properties.latestWkid;
    if (!value) return 'EPSG:4326';
  }
  if (typeof value === 'number' && Number.isInteger(value))
    return `EPSG:${value}`;
  const text =
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
      ? String(value).trim()
      : (JSON.stringify(value) ?? '').trim();
  const upper = text.toUpperCase();
  if (['CRS84', 'OGC:CRS84', 'URN:OGC:DEF:CRS:OGC:1.3:CRS84'].includes(upper))
    return 'CRS84';
  const match = /(?:EPSG(?::|\/|::)|\/EPSG\/[^/]*\/|EPSG\.XML#)(\d+)$/.exec(
    upper,
  );
  if (match) return `EPSG:${match[1]}`;
  if (/^\d+$/.test(text)) return `EPSG:${text}`;
  return text;
}

function isTruthy(value: unknown): boolean {
  if (value == null || value === false || value === '' || value === 0)
    return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
