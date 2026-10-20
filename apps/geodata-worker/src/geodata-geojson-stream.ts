import { createHash } from 'node:crypto';
import { JSONParser } from '@streamparser/json';
import { pythonTruthy } from '@app/platform/python-truthiness.js';
import {
  MAX_IMPORT_FEATURE_BYTES,
  MAX_IMPORT_FEATURE_VERTICES,
} from '@app/platform/import-limits.js';
import {
  setSourceFeatureHashOverride,
  sourceFeatureHashOverride,
} from './geodata-source-feature-hash.js';

const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_NESTING_DEPTH = 128;
const PARSER_CHUNK_BYTES = 64 * 1024;
const MAX_ROOT_KEY_BYTES = 1024;
// @streamparser/json exports these enum values as a const enum, unavailable
// under this project's isolated module compilation.
const TOKEN_PARSER_OBJECT_MODE = 0;
const TOKEN_PARSER_ARRAY_MODE = 1;
const sourceJsonByFeature = new WeakMap<
  object,
  {
    rawJson: string;
    inheritedCrsJson?: string;
    rootGeometryDocument?: boolean;
    sourceHashOverride?: string;
  }
>();

export function sourceJsonForGeoJsonFeature(feature: unknown):
  | {
      rawJson: string;
      inheritedCrsJson?: string;
      rootGeometryDocument?: boolean;
      sourceHashOverride?: string;
    }
  | undefined {
  return isObject(feature) ? sourceJsonByFeature.get(feature) : undefined;
}

export function sourceHashOverrideForGeoJsonFeature(
  feature: unknown,
): string | undefined {
  return isObject(feature)
    ? (sourceJsonByFeature.get(feature)?.sourceHashOverride ??
        sourceFeatureHashOverride(feature))
    : undefined;
}

type ContainerFrame = {
  kind: 'object' | 'array';
  root?: boolean;
  features?: boolean;
  featureItem?: boolean;
  key?: string;
  expectKey?: boolean;
};

/** Read root metadata without retaining features, matching the reference's first parse pass. */
export async function readGeoJsonDocumentMetadata(
  source: AsyncIterable<Uint8Array>,
  heartbeat: () => Promise<void>,
) {
  const parser = new JSONParser({
    paths: ['$.crs', '$.spatialReference', '$.type'],
    keepStack: false,
    stringBufferSize: 64 * 1024,
  });
  const rootValueGuard = new GeoJsonResourceGuard(undefined, false, true);
  let documentCrs: unknown;
  let hasDocumentCrs = false;
  let spatialReference: unknown;
  let hasSpatialReference = false;
  let rootType: unknown;
  let hasRootType = false;
  let sourceBytes = 0;
  let lastHeartbeatBytes = 0;
  const sourceLimit = Math.min(
    positiveEnv(process.env.MYOTA_GEOJSON_MAX_UPLOAD_BYTES, 256 * 1024 * 1024),
    MAX_SOURCE_BYTES,
  );

  parser.onValue = ({ value, key, stack }) => {
    if (stack.length !== 1 || stack[0]?.mode !== TOKEN_PARSER_OBJECT_MODE)
      return;
    if (key === 'type' && !hasRootType) {
      rootType = value;
      hasRootType = true;
    } else if (key === 'crs' && !hasDocumentCrs) {
      documentCrs = value;
      hasDocumentCrs = true;
    } else if (key === 'spatialReference' && !hasSpatialReference) {
      spatialReference = value;
      hasSpatialReference = true;
    }
  };

  for await (const incoming of source) {
    const chunk = Buffer.isBuffer(incoming) ? incoming : Buffer.from(incoming);
    sourceBytes += chunk.length;
    if (sourceBytes > sourceLimit)
      throw new Error('GeoJSON source exceeds the configured upload limit');
    for (let offset = 0; offset < chunk.length; offset += PARSER_CHUNK_BYTES) {
      const part = chunk.subarray(offset, offset + PARSER_CHUNK_BYTES);
      rootValueGuard.write(part);
      parser.write(part);
      if (sourceBytes - lastHeartbeatBytes >= 32 * 1024 * 1024) {
        await heartbeat();
        lastHeartbeatBytes = sourceBytes;
      }
    }
  }

  parser.end();
  const crsSourceKey =
    !hasDocumentCrs || documentCrs === null || documentCrs === undefined
      ? 'spatialReference'
      : 'crs';
  return {
    crs: crsSourceKey === 'spatialReference' ? spatialReference : documentCrs,
    crsSourceKey,
    crsJson: rootValueGuard.rootValueJsonFor(crsSourceKey),
    crsJsonTooLarge: rootValueGuard.rootValueWasTooLarge(crsSourceKey),
    rootType,
  };
}

/**
 * Stream a GeoJSON FeatureCollection or array; single objects are parsed once.
 * Only the current feature is assembled by the parser before it is yielded.
 */
export async function* streamGeoJsonFeatures(
  source: AsyncIterable<Uint8Array>,
  sourceHash: string,
  featureLimit: number,
  documentMetadata: {
    crs: unknown;
    crsSourceKey: string;
    crsJson?: string;
    crsJsonTooLarge?: boolean;
    sourceFeatureHashOverrides?: unknown[];
    rootType: unknown;
  },
  heartbeat: () => Promise<void>,
): AsyncGenerator<unknown> {
  const guard = new GeoJsonResourceGuard(
    documentMetadata.rootType,
    true,
    false,
  );
  const pending: unknown[] = [];
  let featureCount = 0;
  let sourceBytes = 0;
  let lastHeartbeatBytes = 0;
  const digest = createHash('sha256');
  const sourceLimit = Math.min(
    positiveEnv(process.env.MYOTA_GEOJSON_MAX_UPLOAD_BYTES, 256 * 1024 * 1024),
    MAX_SOURCE_BYTES,
  );

  const iterator = source[Symbol.asyncIterator]();
  let parser: JSONParser | undefined;
  while (true) {
    const next = await iterator.next();
    if (next.done) break;
    const incoming = next.value;
    const chunk = Buffer.isBuffer(incoming) ? incoming : Buffer.from(incoming);
    sourceBytes += chunk.length;
    if (sourceBytes > sourceLimit)
      throw new Error('GeoJSON source exceeds the configured upload limit');
    digest.update(chunk);
    for (let offset = 0; offset < chunk.length; offset += PARSER_CHUNK_BYTES) {
      const part = chunk.subarray(offset, offset + PARSER_CHUNK_BYTES);
      guard.write(part);
      let parserPart = part;
      if (!parser) {
        let firstTokenOffset = 0;
        while (
          firstTokenOffset < part.length &&
          isJsonWhitespace(part[firstTokenOffset]!)
        )
          firstTokenOffset++;
        if (firstTokenOffset < part.length) {
          const rootIsArray = part[firstTokenOffset] === 0x5b;
          const rootIsCollection =
            !rootIsArray && documentMetadata.rootType === 'FeatureCollection';
          parser = new JSONParser({
            paths: rootIsArray
              ? ['$.*']
              : rootIsCollection
                ? ['$.features.*']
                : ['$'],
            keepStack: false,
            stringBufferSize: 64 * 1024,
          });
          parser.onValue = ({ value, stack }) => {
            const isTopLevelArrayItem =
              rootIsArray &&
              stack.length === 1 &&
              stack[0]?.mode === TOKEN_PARSER_ARRAY_MODE;
            const isFeatureCollectionItem =
              rootIsCollection &&
              stack.length === 2 &&
              stack[0]?.mode === TOKEN_PARSER_OBJECT_MODE &&
              stack[1]?.mode === TOKEN_PARSER_ARRAY_MODE &&
              stack[1]?.key === 'features';
            const isSingleObject =
              !rootIsArray && !rootIsCollection && stack.length === 0;
            if (
              !isTopLevelArrayItem &&
              !isFeatureCollectionItem &&
              !isSingleObject
            )
              return;

            const feature = isSingleObject ? toGeoJsonFeature(value) : value;
            const sourceJson = isObject(feature)
              ? guard.takeCompletedFeatureJson()
              : undefined;
            const sourceHashOverride =
              typeof documentMetadata.sourceFeatureHashOverrides?.[
                featureCount
              ] === 'string' &&
              /^[0-9a-f]{64}$/.test(
                documentMetadata.sourceFeatureHashOverrides[
                  featureCount
                ] as string,
              )
                ? (documentMetadata.sourceFeatureHashOverrides[
                    featureCount
                  ] as string)
                : undefined;

            featureCount += 1;
            if (featureCount > featureLimit)
              throw new Error(
                `geodata import contains more than ${featureLimit} features`,
              );
            if (countFeatureVertices(feature) > MAX_IMPORT_FEATURE_VERTICES)
              throw new Error(
                `a source geometry exceeds the configured vertex limit (${MAX_IMPORT_FEATURE_VERTICES})`,
              );
            if (
              pythonTruthy(documentMetadata.crs) &&
              documentMetadata.crsJsonTooLarge &&
              isRecord(feature) &&
              !Object.hasOwn(feature, 'crs')
            )
              throw featureSizeError();
            let inheritedDocumentCrs = false;
            if (
              pythonTruthy(documentMetadata.crs) &&
              isRecord(feature) &&
              !Object.hasOwn(feature, 'crs')
            ) {
              (feature as unknown as Record<string, unknown>).crs =
                documentMetadata.crs;
              inheritedDocumentCrs = true;
            }
            if (
              (sourceJson !== undefined || sourceHashOverride !== undefined) &&
              isObject(feature)
            ) {
              if (sourceHashOverride !== undefined)
                setSourceFeatureHashOverride(feature, sourceHashOverride);
              const inheritedCrsJson = inheritedDocumentCrs
                ? documentMetadata.crsJson
                : undefined;
              if (
                sourceJson !== undefined &&
                (!inheritedDocumentCrs || inheritedCrsJson !== undefined)
              )
                sourceJsonByFeature.set(feature, {
                  rawJson: sourceJson,
                  ...(inheritedCrsJson !== undefined
                    ? { inheritedCrsJson }
                    : {}),
                  ...(isSingleObject && documentMetadata.rootType !== 'Feature'
                    ? { rootGeometryDocument: true }
                    : {}),
                  ...(sourceHashOverride !== undefined
                    ? { sourceHashOverride }
                    : {}),
                });
              else if (sourceHashOverride !== undefined)
                sourceJsonByFeature.set(feature, {
                  rawJson: '',
                  sourceHashOverride,
                });
            }
            pending.push(feature);
          };
          parserPart = part.subarray(firstTokenOffset);
        }
      }
      parser?.write(parserPart);
      while (pending.length) yield pending.shift();
      if (sourceBytes - lastHeartbeatBytes >= 32 * 1024 * 1024) {
        await heartbeat();
        lastHeartbeatBytes = sourceBytes;
      }
    }
  }

  parser?.end();
  while (pending.length) yield pending.shift();
  guard.finish();
  if (!sourceBytes) throw new Error('GeoJSON source object is empty');
  if (sourceHash && digest.digest('hex') !== sourceHash)
    throw new Error(
      'geodata import source hash does not match its queued record',
    );
}

class GeoJsonResourceGuard {
  private readonly frames: ContainerFrame[] = [];
  private offset = 0;
  private inString = false;
  private escaped = false;
  private keyCandidate = false;
  private valueCandidate = false;
  private stringBytes = 0;
  private stringParts: number[] = [];
  private scalarFeatureStart: number | undefined;
  private activeFeatureStart: number | undefined;
  private activeFeatureParts: Buffer[] = [];
  private activeFeatureSegmentStart: number | undefined;
  private completedFeatureJson: string[] = [];
  private completedFeatureReadIndex = 0;
  private rootValueJson = new Map<string, string>();
  private oversizedRootValues = new Set<string>();
  private activeRootValueKey: string | undefined;
  private rootValueDepth = 0;
  private rootValueString = false;
  private rootValueOpeningContainer = false;
  private rootValueOverflow = false;
  private rootValueParts: Buffer[] = [];
  private rootValueSegmentStart: number | undefined;
  private rootType: unknown;
  private sawFeaturesArray = false;
  private sawRootArray = false;
  private sawRootObject = false;

  constructor(
    private readonly documentType: unknown,
    private readonly captureFeatureJson = true,
    private readonly captureRootValues = true,
  ) {}

  takeCompletedFeatureJson(): string | undefined {
    const result = this.completedFeatureJson[this.completedFeatureReadIndex];
    if (result !== undefined) this.completedFeatureReadIndex += 1;
    return result;
  }

  rootValueJsonFor(key: string): string | undefined {
    return this.rootValueJson.get(key);
  }

  rootValueWasTooLarge(key: string): boolean {
    return this.oversizedRootValues.has(key);
  }

  write(chunk: Uint8Array) {
    if (this.activeFeatureStart !== undefined)
      this.activeFeatureSegmentStart = 0;
    if (this.captureRootValues && this.activeRootValueKey !== undefined)
      this.rootValueSegmentStart = 0;
    for (let localIndex = 0; localIndex < chunk.length; localIndex += 1) {
      const byte = chunk[localIndex]!;
      const position = this.offset++;
      if (this.inString) {
        this.consumeStringByte(byte, position, localIndex, chunk);
        continue;
      }

      if (this.captureRootValues) this.beginRootValueCapture(byte, localIndex);
      if (
        this.activeRootValueKey !== undefined &&
        this.rootValueDepth === 0 &&
        !this.rootValueString &&
        (byte === 0x2c || byte === 0x7d)
      )
        this.finishRootValueCapture(localIndex, chunk, false);

      if (byte === 0x22) {
        this.inString = true;
        this.escaped = false;
        this.stringBytes = 0;
        this.stringParts = [];
        const frame = this.frames.at(-1);
        this.keyCandidate =
          frame?.kind === 'object' &&
          frame.expectKey === true &&
          frame.root === true;
        this.valueCandidate =
          frame?.kind === 'object' &&
          frame.root === true &&
          frame.key === 'type';
        if (frame?.features && this.scalarFeatureStart === undefined)
          this.scalarFeatureStart = position;
        continue;
      }

      if (byte === 0x7b || byte === 0x5b) {
        this.beginContainer(byte, position, localIndex);
        continue;
      }

      if (byte === 0x7d || byte === 0x5d) {
        this.endContainer(position, localIndex, chunk);
        continue;
      }

      const frame = this.frames.at(-1);
      if (byte === 0x2c) {
        if (frame?.kind === 'object') {
          frame.expectKey = true;
          frame.key = undefined;
        } else if (frame?.features) {
          this.finishScalarFeature(position);
        }
        continue;
      }

      if (
        frame?.features &&
        !isJsonWhitespace(byte) &&
        byte !== 0x3a &&
        byte !== 0x2c
      ) {
        if (this.scalarFeatureStart === undefined)
          this.scalarFeatureStart = position;
      }
      this.checkFeatureSize(position);
    }
    if (
      this.captureFeatureJson &&
      this.activeFeatureStart !== undefined &&
      this.activeFeatureSegmentStart !== undefined
    ) {
      this.activeFeatureParts.push(
        Buffer.from(chunk.subarray(this.activeFeatureSegmentStart)),
      );
      this.activeFeatureSegmentStart = undefined;
    }
    if (
      this.captureRootValues &&
      this.activeRootValueKey !== undefined &&
      this.rootValueSegmentStart !== undefined
    ) {
      this.appendRootValuePart(chunk.subarray(this.rootValueSegmentStart));
      this.rootValueSegmentStart = undefined;
    }
  }

  finish() {
    if (this.inString || this.frames.length)
      throw new Error(
        'GeoJSON source ended before the FeatureCollection was complete',
      );
    if (this.sawRootArray) return;
    if (!this.sawRootObject)
      throw new Error('stored GeoJSON source is not a FeatureCollection');
    if (this.rootType === 'FeatureCollection' && !this.sawFeaturesArray)
      throw new Error('stored GeoJSON FeatureCollection has no features array');
  }

  private consumeStringByte(
    byte: number,
    position: number,
    localIndex: number,
    chunk: Uint8Array,
  ) {
    this.stringBytes += 1;
    if (this.keyCandidate && this.stringBytes > MAX_ROOT_KEY_BYTES)
      throw new Error('GeoJSON root property name exceeds 1024 bytes');
    if (this.valueCandidate && this.stringBytes > 64)
      throw new Error('GeoJSON type value is invalid');
    if (this.stringBytes > MAX_IMPORT_FEATURE_BYTES)
      throw new Error(
        `a GeoJSON string exceeds the configured feature-size limit (${MAX_IMPORT_FEATURE_BYTES} bytes)`,
      );
    if (this.keyCandidate || this.valueCandidate) this.stringParts.push(byte);
    if (!this.escaped && byte === 0x22) {
      this.inString = false;
      const frame = this.frames.at(-1);
      if (frame?.kind === 'object' && frame.expectKey === true) {
        if (this.keyCandidate) {
          frame.key = JSON.parse(
            Buffer.from([0x22, ...this.stringParts]).toString('utf8'),
          );
        }
        frame.expectKey = false;
      } else if (this.valueCandidate && frame?.root) {
        this.rootType = JSON.parse(
          Buffer.from([0x22, ...this.stringParts]).toString('utf8'),
        );
        frame.key = undefined;
      } else if (frame?.kind === 'object') {
        frame.key = undefined;
      }
      this.keyCandidate = false;
      this.valueCandidate = false;
      this.stringParts = [];
      this.checkFeatureSize(position);
      if (this.rootValueString && this.rootValueDepth === 0)
        this.finishRootValueCapture(localIndex, chunk, true);
      return;
    }
    if (this.escaped) this.escaped = false;
    else if (byte === 0x5c) this.escaped = true;
    this.checkFeatureSize(position);
  }

  private beginContainer(byte: number, position: number, localIndex: number) {
    const parent = this.frames.at(-1);
    const kind = byte === 0x7b ? 'object' : 'array';
    if (this.frames.length >= MAX_NESTING_DEPTH)
      throw new Error(`GeoJSON nesting exceeds ${MAX_NESTING_DEPTH} levels`);
    const isRoot = this.frames.length === 0 && kind === 'object';
    const isRootArray = this.frames.length === 0 && kind === 'array';
    const isFeaturesArray =
      kind === 'array' && parent?.root === true && parent.key === 'features';
    const isFeatureItem =
      parent?.features === true ||
      (this.frames.length === 0 &&
        kind === 'object' &&
        this.documentType !== 'FeatureCollection');
    if (isRoot) this.sawRootObject = true;
    if (isRootArray) this.sawRootArray = true;
    if (isFeaturesArray) this.sawFeaturesArray = true;
    if (this.activeRootValueKey !== undefined && this.rootValueDepth > 0) {
      if (this.rootValueOpeningContainer)
        this.rootValueOpeningContainer = false;
      else this.rootValueDepth += 1;
    }
    if (this.captureFeatureJson && isFeatureItem) {
      this.activeFeatureStart = position;
      this.activeFeatureParts = [];
      this.activeFeatureSegmentStart = localIndex;
    }
    if (parent?.root && parent.key === 'type') this.rootType = null;
    if (parent?.kind === 'object') parent.key = undefined;
    this.frames.push({
      kind,
      ...(isRoot ? { root: true } : {}),
      ...(isFeaturesArray || isRootArray ? { features: true } : {}),
      ...(isFeatureItem ? { featureItem: true } : {}),
      ...(kind === 'object' ? { expectKey: true } : {}),
    });
    this.checkFeatureSize(position);
  }

  private endContainer(
    position: number,
    localIndex: number,
    chunk: Uint8Array,
  ) {
    const frame = this.frames.pop();
    if (!frame) throw new Error('GeoJSON source has mismatched containers');
    if (this.activeRootValueKey !== undefined && this.rootValueDepth > 0) {
      this.rootValueDepth -= 1;
      if (this.rootValueDepth === 0)
        this.finishRootValueCapture(localIndex, chunk, true);
    }
    if (frame.featureItem) {
      this.checkFeatureSize(position);
      if (this.activeFeatureSegmentStart !== undefined)
        this.activeFeatureParts.push(
          Buffer.from(
            chunk.subarray(this.activeFeatureSegmentStart, localIndex + 1),
          ),
        );
      this.completedFeatureJson.push(
        Buffer.concat(this.activeFeatureParts).toString('utf8'),
      );
      this.activeFeatureParts = [];
      this.activeFeatureSegmentStart = undefined;
      this.activeFeatureStart = undefined;
      this.scalarFeatureStart = undefined;
    }
    if (frame.features) this.finishScalarFeature(position);
    if (this.frames.length === 1 && this.frames[0].root)
      this.frames[0].key = undefined;
  }

  private finishScalarFeature(position: number) {
    if (
      this.scalarFeatureStart !== undefined &&
      position - this.scalarFeatureStart + 1 > MAX_IMPORT_FEATURE_BYTES
    )
      throw featureSizeError();
    this.scalarFeatureStart = undefined;
  }

  private checkFeatureSize(position: number) {
    if (
      this.activeFeatureStart !== undefined &&
      position - this.activeFeatureStart + 1 > MAX_IMPORT_FEATURE_BYTES
    )
      throw featureSizeError();
    if (
      this.scalarFeatureStart !== undefined &&
      position - this.scalarFeatureStart + 1 > MAX_IMPORT_FEATURE_BYTES
    )
      throw featureSizeError();
  }

  private beginRootValueCapture(byte: number, localIndex: number) {
    if (
      this.activeRootValueKey !== undefined ||
      isJsonWhitespace(byte) ||
      byte === 0x3a ||
      byte === 0x2c ||
      byte === 0x7d
    )
      return;
    const frame = this.frames.at(-1);
    const key =
      frame?.root && frame.expectKey === false ? frame.key : undefined;
    if (key !== 'crs' && key !== 'spatialReference') return;
    this.activeRootValueKey = key;
    this.rootValueParts = [];
    this.rootValueOverflow = false;
    this.rootValueSegmentStart = localIndex;
    this.rootValueString = byte === 0x22;
    if (byte === 0x7b || byte === 0x5b) {
      this.rootValueDepth = 1;
      this.rootValueOpeningContainer = true;
    }
  }

  private appendRootValuePart(bytes: Uint8Array) {
    if (this.rootValueOverflow) return;
    const size = this.rootValueParts.reduce(
      (total, part) => total + part.length,
      0,
    );
    if (size + bytes.length > MAX_IMPORT_FEATURE_BYTES) {
      this.rootValueParts = [];
      this.rootValueOverflow = true;
      return;
    }
    this.rootValueParts.push(Buffer.from(bytes));
  }

  private finishRootValueCapture(
    localIndex: number,
    chunk: Uint8Array,
    includeCurrentByte: boolean,
  ) {
    if (this.rootValueSegmentStart !== undefined) {
      this.appendRootValuePart(
        chunk.subarray(
          this.rootValueSegmentStart,
          localIndex + (includeCurrentByte ? 1 : 0),
        ),
      );
    }
    if (this.activeRootValueKey !== undefined) {
      if (this.rootValueOverflow)
        this.oversizedRootValues.add(this.activeRootValueKey);
      else
        this.rootValueJson.set(
          this.activeRootValueKey,
          Buffer.concat(this.rootValueParts).toString('utf8'),
        );
    }
    this.activeRootValueKey = undefined;
    this.rootValueDepth = 0;
    this.rootValueString = false;
    this.rootValueOpeningContainer = false;
    this.rootValueOverflow = false;
    this.rootValueParts = [];
    this.rootValueSegmentStart = undefined;
  }
}

function featureSizeError() {
  return new Error(
    `a source feature exceeds the configured decoded-size limit (${MAX_IMPORT_FEATURE_BYTES} bytes)`,
  );
}

function countFeatureVertices(value: unknown): number {
  if (!isRecord(value) || !isRecord(value.geometry)) return 0;
  let vertices = 0;
  const pending: unknown[] = [value.geometry.coordinates];
  while (pending.length) {
    const current = pending.pop();
    if (!Array.isArray(current)) continue;
    if (
      current.length >= 2 &&
      typeof current[0] === 'number' &&
      typeof current[1] === 'number'
    ) {
      vertices += 1;
      if (vertices > MAX_IMPORT_FEATURE_VERTICES) return vertices;
    } else {
      for (const item of current) pending.push(item);
    }
  }
  return vertices;
}

function isJsonWhitespace(byte: number) {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function positiveEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function toGeoJsonFeature(value: unknown) {
  if (!isRecord(value)) throw new Error('unsupported GeoJSON document type');
  if (value.type === 'Feature') return value;
  if (isRecord(value.geometry)) {
    const feature: Record<string, unknown> = {
      type: 'Feature',
      geometry: value.geometry,
      properties: pythonTruthy(value.properties) ? value.properties : {},
    };
    if (value.id !== null && value.id !== undefined) feature.id = value.id;
    return feature;
  }
  if (
    [
      'Point',
      'LineString',
      'MultiLineString',
      'Polygon',
      'MultiPolygon',
    ].includes(String(value.type))
  )
    return { type: 'Feature', geometry: value, properties: {} };
  throw new Error('unsupported GeoJSON document type');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}
