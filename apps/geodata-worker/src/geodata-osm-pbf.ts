import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
const MAX_FEATURE_BYTES = 16 * 1024 * 1024;
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

export async function decodeOsmPbf(
  pbf: Uint8Array,
  filename: string,
  featureLimit: number,
  heartbeat: () => Promise<void>,
): Promise<{ type: 'FeatureCollection'; features: GeoJsonFeature[] }> {
  const normalizedFilename = filename.toLowerCase();
  if (!normalizedFilename.endsWith('.pbf') || pbf.length < 4)
    throw new Error('OSM PBF imports must be non-empty .pbf files');

  const directory = await mkdtemp(join(tmpdir(), 'myota-osm-'));
  const sourcePath = join(directory, 'source.osm.pbf');
  const configPath = join(directory, 'export.json');
  try {
    await writeFile(sourcePath, pbf, { mode: 0o600 });
    await writeFile(
      configPath,
      JSON.stringify({
        attributes: { type: 'featureType', id: 'osm_id' },
        area_tags: [...AREA_TAGS],
        linear_tags: [...LINE_TAGS],
      }),
      { mode: 0o600 },
    );
    const output = await runOsmium(sourcePath, configPath, heartbeat);
    const features: GeoJsonFeature[] = [];
    for (const record of output
      .toString('utf8')
      .replaceAll(String.fromCharCode(0x1e), '\n')
      .split(/\r?\n/)) {
      if (!record.trim()) continue;
      const parsed: unknown = JSON.parse(record);
      if (!isRecord(parsed) || parsed.type !== 'Feature') continue;
      const properties = isRecord(parsed.properties) ? parsed.properties : {};
      if (!isRecord(parsed.geometry)) continue;
      const geometry = parsed.geometry;
      const osmType =
        typeof properties.featureType === 'string'
          ? properties.featureType
          : '';
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
      const encoded = Buffer.byteLength(JSON.stringify(feature));
      if (encoded > MAX_FEATURE_BYTES)
        throw new Error('an OSM feature exceeds the 16 MiB decoded-size limit');
      if (countVertices(geometry.coordinates) > MAX_FEATURE_VERTICES)
        throw new Error('an OSM feature exceeds the 250000 vertex limit');
      features.push(feature);
      if (features.length > featureLimit)
        throw new Error(`OSM PBF contains more than ${featureLimit} features`);
    }
    if (!features.length)
      throw new Error(
        'OSM PBF contains no supported hiking or protected-area features',
      );
    return { type: 'FeatureCollection', features };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runOsmium(
  sourcePath: string,
  configPath: string,
  heartbeat: () => Promise<void>,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'osmium',
      [
        'export',
        `--config=${configPath}`,
        '--output-format=geojsonseq',
        '--format-option=print_record_separator=false',
        sourcePath,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const chunks: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    let heartbeatError: unknown;
    let heartbeatInFlight = false;
    let heartbeatPromise = Promise.resolve();
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
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        overflow = true;
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= 64 * 1024) return;
      const remaining = 64 * 1024 - stderrBytes;
      const kept = chunk.subarray(0, remaining);
      stderr.push(kept);
      stderrBytes += kept.length;
    });
    child.on('error', (error) => {
      clearInterval(heartbeatTimer);
      reject(new Error(`OSM PBF decoder could not start: ${error.message}`));
    });
    child.on('close', async (code) => {
      clearInterval(heartbeatTimer);
      await heartbeatPromise;
      if (heartbeatError) {
        reject(heartbeatError);
        return;
      }
      if (overflow) {
        reject(new Error('OSM PBF decoded output exceeds 128 MiB'));
        return;
      }
      if (code !== 0) {
        const details = Buffer.concat(stderr).toString('utf8').trim();
        reject(
          new Error(`OSM PBF decoding failed${details ? `: ${details}` : ''}`),
        );
        return;
      }
      resolve(Buffer.concat(chunks, outputBytes));
    });
  });
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
