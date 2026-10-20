import { createHash } from 'node:crypto';
import { pythonFloatString } from '@app/platform/python-number.js';
import { comparePythonStrings } from '@app/platform/python-string.js';

class JsonNumber {
  constructor(
    readonly value: number | bigint,
    readonly floating: boolean,
  ) {}
}

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

/** Preserve source number tokens for direct GeoJSON and WFS import payloads. */
export function rawGeoJsonImportDocument(
  rawRequest: string,
): string | undefined {
  const request = new JsonParser(rawRequest).parse();
  if (!isRecord(request)) return undefined;
  const format =
    typeof request.format === 'string'
      ? request.format.toUpperCase()
      : 'GEOJSON';
  if (format !== 'GEOJSON' && format !== 'WFS') return undefined;
  if (Array.isArray(request.features))
    return `{"features":${canonicalJsonValue(request.features)},"type":"FeatureCollection"}`;
  if (typeof request.content === 'string') {
    try {
      return canonicalPythonJson(request.content);
    } catch {
      return undefined;
    }
  }
  return undefined;
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

class JsonParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    const result = this.value();
    this.whitespace();
    if (this.index !== this.source.length)
      throw new Error('invalid JSON request body');
    return result;
  }

  private value(): unknown {
    this.whitespace();
    const character = this.source[this.index];
    if (character === '{') return this.object();
    if (character === '[') return this.array();
    if (character === '"') return this.string();
    if (character === 't') return this.literal('true', true);
    if (character === 'f') return this.literal('false', false);
    if (character === 'n') return this.literal('null', null);
    return this.number();
  }

  private object(): Record<string, unknown> {
    this.index += 1;
    this.whitespace();
    const result: Record<string, unknown> = Object.create(null);
    if (this.source[this.index] === '}') {
      this.index += 1;
      return result;
    }
    while (true) {
      this.whitespace();
      const key = this.string();
      this.whitespace();
      this.expect(':');
      result[key] = this.value();
      this.whitespace();
      if (this.source[this.index] === '}') {
        this.index += 1;
        return result;
      }
      this.expect(',');
    }
  }

  private array(): unknown[] {
    this.index += 1;
    this.whitespace();
    const result: unknown[] = [];
    if (this.source[this.index] === ']') {
      this.index += 1;
      return result;
    }
    while (true) {
      result.push(this.value());
      this.whitespace();
      if (this.source[this.index] === ']') {
        this.index += 1;
        return result;
      }
      this.expect(',');
    }
  }

  private string(): string {
    const start = this.index;
    this.expect('"');
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character === '"') {
        this.index += 1;
        return JSON.parse(this.source.slice(start, this.index)) as string;
      }
      if (character === '\\') this.index += 1;
      this.index += 1;
    }
    throw new Error('invalid JSON request body');
  }

  private number(): JsonNumber {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      this.source.slice(this.index),
    );
    if (!match) throw new Error('invalid JSON request body');
    this.index += match[0].length;
    const floating = /[.eE]/.test(match[0]);
    return new JsonNumber(
      floating ? Number(match[0]) : BigInt(match[0]),
      floating,
    );
  }

  private literal<T>(source: string, value: T): T {
    if (!this.source.startsWith(source, this.index))
      throw new Error('invalid JSON request body');
    this.index += source.length;
    return value;
  }

  private whitespace() {
    while (/\s/.test(this.source[this.index] ?? '')) this.index += 1;
  }

  private expect(character: string) {
    if (this.source[this.index] !== character)
      throw new Error('invalid JSON request body');
    this.index += 1;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
