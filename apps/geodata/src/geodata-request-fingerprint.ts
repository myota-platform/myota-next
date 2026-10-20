import { createHash } from 'node:crypto';
import { pythonFloatString } from '@app/platform/python-number.js';
import { comparePythonStrings } from '@app/platform/python-string.js';
import { JsonNumber, JsonParser } from '@app/platform/json-exact.js';

export function fingerprintJsonRequest(
  body: unknown,
  rawBody?: string,
): string {
  const parsed = rawBody === undefined ? body : new JsonParser(rawBody).parse();
  const value = isPythonTruthyJson(parsed) ? parsed : {};
  return createHash('sha256').update(pythonJson(value)).digest('hex');
}

/** Canonicalize raw JSON with Python's compact, sorted, Unicode-preserving form. */
export function canonicalPythonJson(rawBody: string): string {
  return canonicalJsonValue(new JsonParser(rawBody).parse());
}

export function canonicalPythonGeneratedJson(
  value: unknown,
  isFloat: (path: readonly (string | number)[], value: number) => boolean,
): string {
  const canonical = (
    item: unknown,
    path: readonly (string | number)[],
  ): string => {
    if (item === null) return 'null';
    if (typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'boolean') return item ? 'true' : 'false';
    if (typeof item === 'number')
      return isFloat(path, item)
        ? pythonFloatString(item)
        : Number.isInteger(item)
          ? String(item)
          : pythonFloatString(item);
    if (typeof item === 'bigint') return String(item);
    if (Array.isArray(item))
      return `[${item
        .map((child, index) => canonical(child, [...path, index]))
        .join(',')}]`;
    if (isRecord(item))
      return `{${Object.keys(item)
        .sort(comparePythonStrings)
        .map(
          (key) =>
            `${JSON.stringify(key)}:${canonical(item[key], [...path, key])}`,
        )
        .join(',')}}`;
    return 'null';
  };
  return canonical(value, []);
}

export function canonicalPythonJsonWithProperty(
  rawObject: string,
  key: string,
  rawValue: string,
): string {
  const value = new JsonParser(rawObject).parse();
  if (!isRecord(value)) return canonicalJsonValue(value);
  value[key] = new JsonParser(rawValue).parse();
  return canonicalJsonValue(value);
}

export function canonicalPythonGeoJsonFeature(
  rawDocument: string,
  inheritedCrsJson?: string,
): string {
  const document = new JsonParser(rawDocument).parse();
  if (!isRecord(document)) return canonicalJsonValue(document);

  let feature: Record<string, unknown>;
  if (isRecord(document.geometry)) {
    feature = {
      type: 'Feature',
      geometry: document.geometry,
      properties: isPythonTruthyJson(document.properties)
        ? document.properties
        : {},
    };
    if (document.id !== null && document.id !== undefined)
      feature.id = document.id;
  } else if (
    [
      'Point',
      'LineString',
      'MultiLineString',
      'Polygon',
      'MultiPolygon',
    ].includes(String(document.type))
  ) {
    feature = { type: 'Feature', geometry: document, properties: {} };
  } else {
    feature = document;
  }

  if (inheritedCrsJson !== undefined && !Object.hasOwn(feature, 'crs'))
    feature.crs = new JsonParser(inheritedCrsJson).parse();
  return canonicalJsonValue(feature);
}

export function rawImportSourceData(rawRequest: string): {
  rawDocumentJson?: string;
  sourceFeatureHashOverrides?: string[];
} {
  const request = new JsonParser(rawRequest).parse();
  if (!isRecord(request)) return {};
  const format =
    typeof request.format === 'string'
      ? request.format.toUpperCase()
      : 'GEOJSON';
  if (format === 'GEOJSON' || format === 'WFS') {
    if (Array.isArray(request.features))
      return {
        rawDocumentJson: `{"features":${canonicalJsonValue(request.features)},"type":"FeatureCollection"}`,
      };
    if (typeof request.content !== 'string') return {};
    try {
      return { rawDocumentJson: canonicalPythonJson(request.content) };
    } catch {
      return {};
    }
  }
  let document: unknown;
  if (format !== 'ARCGIS_FEATURESERVER') return {};
  if (Array.isArray(request.features))
    document = { features: request.features };
  else if (typeof request.content === 'string') {
    try {
      document = new JsonParser(request.content).parse();
    } catch {
      return {};
    }
  }
  if (!isRecord(document) || !Array.isArray(document.features)) return {};
  return {
    sourceFeatureHashOverrides: document.features.map((feature) =>
      createHash('sha256')
        .update(canonicalJsonValue(feature), 'utf8')
        .digest('hex'),
    ),
  };
}

export function scheduledFeatureHashOverrides(
  rawDocument: string,
  format: string,
): string[] | undefined {
  let document: unknown;
  try {
    document = new JsonParser(rawDocument).parse();
  } catch {
    return undefined;
  }
  let features: unknown[] | undefined;
  if (
    isRecord(document) &&
    document.type === 'FeatureCollection' &&
    Array.isArray(document.features) &&
    document.features.every(isRecord)
  ) {
    features = document.features;
  } else if (format === 'ARCGIS_FEATURESERVER' && isRecord(document)) {
    if (!Array.isArray(document.features)) return undefined;
    features = [];
    for (const raw of document.features) {
      if (!isRecord(raw)) return undefined;
      const geometry = isRecord(raw.geometry) ? raw.geometry : {};
      const properties = isRecord(raw.attributes) ? raw.attributes : {};
      let normalizedGeometry: Record<string, unknown>;
      if (Array.isArray(geometry.rings))
        normalizedGeometry = {
          type: 'Polygon',
          coordinates: geometry.rings,
        };
      else if (Array.isArray(geometry.paths))
        normalizedGeometry = {
          type: 'MultiLineString',
          coordinates: geometry.paths,
        };
      else if (
        geometry.x instanceof JsonNumber &&
        geometry.y instanceof JsonNumber
      )
        normalizedGeometry = {
          type: 'Point',
          coordinates: [geometry.x, geometry.y],
        };
      else return undefined;
      features.push({
        type: 'Feature',
        properties,
        geometry: normalizedGeometry,
      });
    }
  }
  if (!features) return undefined;
  return features.map((feature) =>
    createHash('sha256')
      .update(canonicalJsonValue(feature), 'utf8')
      .digest('hex'),
  );
}

function canonicalJsonValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof JsonNumber)
    return value.floating
      ? pythonFloatString(value.value as number)
      : String(value.value);
  if (typeof value === 'number')
    return Number.isInteger(value) ? String(value) : pythonFloatString(value);
  if (typeof value === 'bigint') return String(value);
  if (Array.isArray(value))
    return `[${value.map(canonicalJsonValue).join(',')}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort(comparePythonStrings)
      .map((key) => `${JSON.stringify(key)}:${canonicalJsonValue(value[key])}`)
      .join(',')}}`;
  return 'null';
}

function pythonJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return pythonJsonString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof JsonNumber)
    return value.floating
      ? pythonFloatString(value.value as number)
      : String(value.value);
  if (typeof value === 'number')
    return Number.isInteger(value) ? String(value) : pythonFloatString(value);
  if (typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(', ')}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort(comparePythonStrings)
      .map((key) => `${pythonJsonString(key)}: ${pythonJson(value[key])}`)
      .join(', ')}}`;
  return 'null';
}

function pythonJsonString(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function isPythonTruthyJson(value: unknown): boolean {
  if (value === null || value === false) return false;
  if (typeof value === 'string' || Array.isArray(value))
    return value.length > 0;
  if (value instanceof JsonNumber)
    return typeof value.value === 'bigint'
      ? value.value !== 0n
      : value.value !== 0;
  if (typeof value === 'number' || typeof value === 'bigint')
    return value !== 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
