import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MAX_IMPORT_FEATURE_BYTES } from '@app/platform/import-limits.js';
import { canonicalPythonGeneratedJson } from '../../geodata/src/geodata-request-fingerprint.js';
import { setSourceFeatureHashOverride } from './geodata-source-feature-hash.js';

const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
const MAX_FEATURE_VERTICES = 250_000;
const REQUIRED_TAGS = [
  'leisure=park',
  'leisure=nature_reserve',
  'boundary=protected_area',
  'landuse=recreation_ground',
  'highway=path',
  'highway=footway',
  'highway=track',
  'highway=bridleway',
  'route=hiking',
];
const LINE_TAGS = new Set([
  'highway=path',
  'highway=footway',
  'highway=track',
  'highway=bridleway',
  'route=hiking',
]);
const AREA_TAGS = new Set([
  'leisure=park',
  'leisure=nature_reserve',
  'boundary=protected_area',
  'landuse=recreation_ground',
]);

type GeoJsonFeature = {
  type: 'Feature';
  id: string;
  properties: Record<string, unknown>;
  geometry: Record<string, unknown>;
};

export async function* decodeOsmPbfStream(
  source: AsyncIterable<Uint8Array>,
  filename: string,
  featureLimit: number,
  sourceHash: string,
  heartbeat: () => Promise<void>,
): AsyncGenerator<GeoJsonFeature> {
  const normalizedFilename = filename.toLowerCase();
  if (!normalizedFilename.endsWith('.pbf'))
    throw new Error('OSM PBF imports must use a .pbf filename');

  const directory = await mkdtemp(join(tmpdir(), 'myota-osm-'));
  const sourcePath = join(directory, 'source.osm.pbf');
  const configPath = join(directory, 'export.json');
  const locationIndexPath = join(directory, 'node-locations.store');
  try {
    const digest = createHash('sha256');
    let sourceBytes = 0;
    const sourceLimit = Math.min(
      positiveEnv(
        process.env.MYOTA_OSM_PBF_MAX_UPLOAD_BYTES,
        256 * 1024 * 1024,
      ),
      MAX_SOURCE_BYTES,
    );
    const sourceGuard = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sourceBytes += chunk.length;
        if (sourceBytes > sourceLimit) {
          callback(
            new Error('OSM PBF source exceeds the configured size limit'),
          );
          return;
        }
        digest.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.from(source),
      sourceGuard,
      createWriteStream(sourcePath, { flags: 'wx', mode: 0o600 }),
    );
    if (!sourceBytes) throw new Error('OSM PBF source object is empty');
    if (sourceHash && digest.digest('hex') !== sourceHash)
      throw new Error(
        'geodata import source hash does not match its queued record',
      );
    await writeFile(
      configPath,
      stringifyJsonWithBigInts({
        attributes: { type: 'featureType', id: 'osm_id' },
        area_tags: [...AREA_TAGS],
        linear_tags: [...LINE_TAGS],
      }),
      { mode: 0o600 },
    );
    for await (const feature of parseOsmiumFeatures(
      sourcePath,
      configPath,
      locationIndexPath,
      heartbeat,
      featureLimit,
    ))
      yield feature;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function* parseOsmiumFeatures(
  sourcePath: string,
  configPath: string,
  locationIndexPath: string,
  heartbeat: () => Promise<void>,
  featureLimit: number,
): AsyncGenerator<GeoJsonFeature> {
  let featureCount = 0;
  for await (const record of runOsmium(
    sourcePath,
    configPath,
    locationIndexPath,
    heartbeat,
  )) {
    const parsed: unknown = JSON.parse(record);
    if (!isRecord(parsed) || parsed.type !== 'Feature') continue;
    const properties = isRecord(parsed.properties) ? parsed.properties : {};
    if (!isRecord(parsed.geometry)) continue;
    const geometry = parsed.geometry;
    const osmType =
      typeof properties.featureType === 'string' ? properties.featureType : '';
    const osmId = properties.osm_id;
    if (!['node', 'way', 'relation'].includes(osmType)) continue;
    if (typeof osmId !== 'string' && typeof osmId !== 'number') continue;
    const tags = Object.entries(properties).filter(
      ([key]) => !['featureType', 'osm_id'].includes(key),
    );
    const tagKeys = new Set(
      tags.map(([key, value]) => `${key}=${String(value)}`),
    );
    const isArea =
      geometry.type === 'Polygon' || geometry.type === 'MultiPolygon';
    const isLine = geometry.type === 'LineString';
    const isPoint = geometry.type === 'Point';
    if (
      (isArea && ![...AREA_TAGS].some((tag) => tagKeys.has(tag))) ||
      (isLine && ![...LINE_TAGS].some((tag) => tagKeys.has(tag))) ||
      (isPoint && !REQUIRED_TAGS.some((tag) => tagKeys.has(tag))) ||
      (!isArea && !isLine && !isPoint)
    )
      continue;

    const sourceRef = `${osmType}/${osmId}`;
    const featureProperties: Record<string, unknown> = {
      ...properties,
      id: sourceRef,
      osm_id: sourceRef,
      sourceRef,
      featureType: osmType,
    };
    const feature: GeoJsonFeature = {
      type: 'Feature',
      id: sourceRef,
      properties: featureProperties,
      geometry,
    };
    const canonical = canonicalPythonGeneratedJson(
      feature,
      (path) => path[0] === 'geometry' && path[1] === 'coordinates',
    );
    setSourceFeatureHashOverride(
      feature,
      createHash('sha256').update(canonical, 'utf8').digest('hex'),
    );
    const encoded = Buffer.byteLength(canonical, 'utf8');
    if (encoded > MAX_IMPORT_FEATURE_BYTES)
      throw new Error(
        `an OSM feature exceeds the configured decoded-size limit (${MAX_IMPORT_FEATURE_BYTES} bytes)`,
      );
    if (countVertices(geometry.coordinates) > MAX_FEATURE_VERTICES)
      throw new Error('an OSM feature exceeds the 250000 vertex limit');
    featureCount += 1;
    if (featureCount > featureLimit)
      throw new Error(`OSM PBF contains more than ${featureLimit} features`);
    yield feature;
  }
  if (!featureCount)
    throw new Error(
      'OSM PBF contains no supported hiking or protected-area features',
    );
}

function positiveEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function* runOsmium(
  sourcePath: string,
  configPath: string,
  locationIndexPath: string,
  heartbeat: () => Promise<void>,
): AsyncGenerator<string> {
  const child = spawn(
    'osmium',
    [
      'export',
      `--config=${configPath}`,
      `--index-type=sparse_file_array,${locationIndexPath}`,
      '--output-format=geojsonseq',
      '--format-option=print_record_separator=false',
      sourcePath,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let stderrBytes = 0;
  let overflow = false;
  let heartbeatError: unknown;
  let spawnError: Error | undefined;
  let heartbeatInFlight = false;
  let heartbeatPromise = Promise.resolve();
  let exitCode: number | null = null;
  let closeSignal: NodeJS.Signals | null = null;
  const closed = new Promise<void>((resolve) => {
    child.once('close', (code, signal) => {
      exitCode = code;
      closeSignal = signal;
      resolve();
    });
  });
  const heartbeatTimer = setInterval(() => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;
    heartbeatPromise = heartbeat()
      .catch((error: unknown) => {
        heartbeatError = error;
        child.kill('SIGTERM');
      })
      .finally(() => {
        heartbeatInFlight = false;
      });
  }, 60_000);
  heartbeatTimer.unref();
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderrBytes >= 64 * 1024) return;
    const remaining = 64 * 1024 - stderrBytes;
    const kept = chunk.subarray(0, remaining);
    stderr.push(kept);
    stderrBytes += kept.length;
  });
  child.once('error', (error) => {
    spawnError = error;
  });

  let pending = '';
  const decoder = new StringDecoder('utf8');
  let streamError: unknown;
  try {
    for await (const chunk of child.stdout) {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        overflow = true;
        child.kill('SIGKILL');
        continue;
      }
      pending += decoder.write(chunk);
      const records = pending
        .replaceAll(String.fromCharCode(0x1e), '\n')
        .split(/[\r\n]+/);
      pending = records.pop() ?? '';
      for (const record of records) if (record.trim()) yield record.trim();
    }
    pending += decoder.end();
    if (pending.trim()) yield pending.trim();
  } catch (error) {
    streamError = error;
    child.kill('SIGTERM');
  } finally {
    clearInterval(heartbeatTimer);
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGTERM');
    await closed;
    await heartbeatPromise;
  }

  if (spawnError)
    throw new Error(`OSM PBF decoder could not start: ${spawnError.message}`);
  if (heartbeatError) throw heartbeatError;
  if (overflow) throw new Error('OSM PBF decoded output exceeds 128 MiB');
  if (streamError) throw streamError;
  if (exitCode !== 0) {
    const details = Buffer.concat(stderr).toString('utf8').trim();
    throw new Error(
      `OSM PBF decoding failed${details ? `: ${details}` : ''}${closeSignal ? ` (${String(closeSignal)})` : ''}`,
    );
  }
}

function countVertices(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  if (
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number'
  )
    return 1;
  return value.reduce<number>((total, item) => total + countVertices(item), 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
