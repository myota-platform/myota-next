import { createHash } from 'node:crypto';
import { JSONParser } from '@streamparser/json';

const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_FEATURE_BYTES = 16 * 1024 * 1024;
const MAX_FEATURE_VERTICES = 250_000;
const MAX_NESTING_DEPTH = 128;
const PARSER_CHUNK_BYTES = 64 * 1024;
const MAX_ROOT_KEY_BYTES = 1024;

type ContainerFrame = {
  kind: 'object' | 'array';
  root?: boolean;
  features?: boolean;
  featureItem?: boolean;
  key?: string;
  expectKey?: boolean;
};

/**
 * Stream a GeoJSON FeatureCollection from its object-store body. Only the
 * current feature is assembled by the JSON parser; completed features are
 * yielded to the worker before more source bytes are consumed.
 */
export async function* streamGeoJsonFeatures(
  source: AsyncIterable<Uint8Array>,
  sourceHash: string,
  featureLimit: number,
  heartbeat: () => Promise<void>,
): AsyncGenerator<unknown> {
  const parser = new JSONParser({
    paths: ['$.features.*'],
    keepStack: false,
    stringBufferSize: 64 * 1024,
  });
  const guard = new GeoJsonResourceGuard();
  const pending: unknown[] = [];
  let featureCount = 0;
  let sourceBytes = 0;
  let lastHeartbeatBytes = 0;
  const digest = createHash('sha256');
  const sourceLimit = Math.min(
    positiveEnv(process.env.MYOTA_GEOJSON_MAX_UPLOAD_BYTES, 256 * 1024 * 1024),
    MAX_SOURCE_BYTES,
  );

  parser.onValue = ({ value }) => {
    featureCount += 1;
    if (featureCount > featureLimit)
      throw new Error(
        `geodata import contains more than ${featureLimit} features`,
      );
    if (countFeatureVertices(value) > MAX_FEATURE_VERTICES)
      throw new Error(
        `a source geometry exceeds the configured vertex limit (${MAX_FEATURE_VERTICES})`,
      );
    pending.push(value);
  };

  for await (const incoming of source) {
    const chunk = Buffer.isBuffer(incoming) ? incoming : Buffer.from(incoming);
    sourceBytes += chunk.length;
    if (sourceBytes > sourceLimit)
      throw new Error('GeoJSON source exceeds the configured upload limit');
    digest.update(chunk);
    for (let offset = 0; offset < chunk.length; offset += PARSER_CHUNK_BYTES) {
      const part = chunk.subarray(offset, offset + PARSER_CHUNK_BYTES);
      guard.write(part);
      parser.write(part);
      while (pending.length) yield pending.shift();
      if (sourceBytes - lastHeartbeatBytes >= 32 * 1024 * 1024) {
        await heartbeat();
        lastHeartbeatBytes = sourceBytes;
      }
    }
  }

  parser.end();
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
  private rootType: unknown;
  private sawFeaturesArray = false;

  write(chunk: Uint8Array) {
    for (const byte of chunk) {
      const position = this.offset++;
      if (this.inString) {
        this.consumeStringByte(byte, position);
        continue;
      }

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
        this.beginContainer(byte, position);
        continue;
      }

      if (byte === 0x7d || byte === 0x5d) {
        this.endContainer(position);
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
  }

  finish() {
    if (this.inString || this.frames.length)
      throw new Error(
        'GeoJSON source ended before the FeatureCollection was complete',
      );
    if (this.rootType !== 'FeatureCollection' || !this.sawFeaturesArray)
      throw new Error('stored GeoJSON source is not a FeatureCollection');
  }

  private consumeStringByte(byte: number, position: number) {
    this.stringBytes += 1;
    if (this.keyCandidate && this.stringBytes > MAX_ROOT_KEY_BYTES)
      throw new Error('GeoJSON root property name exceeds 1024 bytes');
    if (this.valueCandidate && this.stringBytes > 64)
      throw new Error('GeoJSON type value is invalid');
    if (this.stringBytes > MAX_FEATURE_BYTES)
      throw new Error('a GeoJSON string exceeds the 16 MiB feature-size limit');
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
      return;
    }
    if (this.escaped) this.escaped = false;
    else if (byte === 0x5c) this.escaped = true;
    this.checkFeatureSize(position);
  }

  private beginContainer(byte: number, position: number) {
    const parent = this.frames.at(-1);
    const kind = byte === 0x7b ? 'object' : 'array';
    if (this.frames.length >= MAX_NESTING_DEPTH)
      throw new Error(`GeoJSON nesting exceeds ${MAX_NESTING_DEPTH} levels`);
    const isRoot = this.frames.length === 0 && kind === 'object';
    const isFeaturesArray =
      kind === 'array' && parent?.root === true && parent.key === 'features';
    const isFeatureItem = parent?.features === true;
    if (isFeaturesArray) this.sawFeaturesArray = true;
    if (isFeatureItem) this.activeFeatureStart = position;
    if (parent?.root && parent.key === 'type') this.rootType = null;
    if (parent?.kind === 'object') parent.key = undefined;
    this.frames.push({
      kind,
      ...(isRoot ? { root: true } : {}),
      ...(isFeaturesArray ? { features: true } : {}),
      ...(isFeatureItem ? { featureItem: true } : {}),
      ...(kind === 'object' ? { expectKey: true } : {}),
    });
    this.checkFeatureSize(position);
  }

  private endContainer(position: number) {
    const frame = this.frames.pop();
    if (!frame) throw new Error('GeoJSON source has mismatched containers');
    if (frame.featureItem) {
      this.checkFeatureSize(position);
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
      position - this.scalarFeatureStart + 1 > MAX_FEATURE_BYTES
    )
      throw new Error('a GeoJSON feature exceeds the 16 MiB size limit');
    this.scalarFeatureStart = undefined;
  }

  private checkFeatureSize(position: number) {
    if (
      this.activeFeatureStart !== undefined &&
      position - this.activeFeatureStart + 1 > MAX_FEATURE_BYTES
    )
      throw new Error('a GeoJSON feature exceeds the 16 MiB size limit');
    if (
      this.scalarFeatureStart !== undefined &&
      position - this.scalarFeatureStart + 1 > MAX_FEATURE_BYTES
    )
      throw new Error('a GeoJSON feature exceeds the 16 MiB size limit');
  }
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
      if (vertices > MAX_FEATURE_VERTICES) return vertices;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
