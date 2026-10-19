import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import proj4, { type Converter } from 'proj4';
import yauzl from 'yauzl';
import { open as openShapefile } from 'shapefile';

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const MAX_ARCHIVE_MEMBERS = 100;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_FEATURE_VERTICES = 250_000;
const MAX_METADATA_BYTES = 1024 * 1024;

type ExtractedMember = { path: string; size: number };

/** Stream a ZIP Shapefile source through disk-backed archive and record readers. */
export async function* streamShapefileFeatures(
  source: AsyncIterable<Uint8Array>,
  filename: string,
  sourceHash: string,
  featureLimit: number,
  heartbeat: () => Promise<void>,
): AsyncGenerator<unknown> {
  if (!filename.toLowerCase().endsWith('.zip'))
    throw new Error('Shapefile imports must be ZIP archives');

  const directory = await mkdtemp(join(tmpdir(), 'myota-shapefile-'));
  let zip: yauzl.ZipFile | undefined;
  try {
    const archivePath = join(directory, 'source.zip');
    const hash = createHash('sha256');
    let archiveBytes = 0;
    let lastHeartbeatBytes = 0;
    const archiveLimit = Math.min(
      positiveEnv(
        process.env.MYOTA_SHAPEFILE_MAX_UPLOAD_BYTES,
        256 * 1024 * 1024,
      ),
      MAX_ARCHIVE_BYTES,
    );
    await pipeline(
      source,
      async function* (input) {
        for await (const incoming of input) {
          const chunk = Buffer.isBuffer(incoming)
            ? incoming
            : Buffer.from(incoming);
          archiveBytes += chunk.length;
          if (archiveBytes > archiveLimit)
            throw new Error(
              'Shapefile ZIP exceeds the configured upload limit',
            );
          hash.update(chunk);
          yield chunk;
          if (archiveBytes - lastHeartbeatBytes >= 32 * 1024 * 1024) {
            await heartbeat();
            lastHeartbeatBytes = archiveBytes;
          }
        }
      },
      createWriteStream(archivePath, { flags: 'wx' }),
    );
    if (!archiveBytes) throw new Error('Shapefile ZIP source is empty');
    if (sourceHash && hash.digest('hex') !== sourceHash)
      throw new Error(
        'geodata import source hash does not match its queued record',
      );

    zip = await yauzl.openPromise(archivePath, {
      lazyEntries: true,
      strictFileNames: true,
      validateEntrySizes: true,
    });
    const members = new Map<string, ExtractedMember>();
    const names = new Set<string>();
    let expandedBytes = 0;
    let memberIndex = 0;
    for await (const entry of zip.eachEntry()) {
      memberIndex += 1;
      if (memberIndex > MAX_ARCHIVE_MEMBERS)
        throw new Error(
          `Shapefile ZIP has more than ${MAX_ARCHIVE_MEMBERS} files`,
        );
      const name = entry.fileName.replaceAll('\\', '/');
      const normalizedName = name.toLowerCase();
      if (names.has(normalizedName))
        throw new Error('Shapefile ZIP contains duplicate file names');
      names.add(normalizedName);
      expandedBytes += entry.uncompressedSize;
      if (expandedBytes > MAX_EXPANDED_BYTES)
        throw new Error('Shapefile ZIP expands beyond 1 GiB');
      if (
        normalizedName.endsWith('.prj') &&
        entry.uncompressedSize > MAX_METADATA_BYTES
      )
        throw new Error('Shapefile projection metadata exceeds 1 MiB');
      if (
        normalizedName.endsWith('.cpg') &&
        entry.uncompressedSize > MAX_METADATA_BYTES
      )
        throw new Error('Shapefile encoding metadata exceeds 1 MiB');

      const leafName = basename(name);
      if (
        !leafName ||
        name.endsWith('/') ||
        normalizedName.includes('__macosx/') ||
        leafName.startsWith('._') ||
        !/\.(shp|shx|dbf|prj|cpg)$/i.test(leafName)
      )
        continue;

      const extension = leafName.slice(leafName.lastIndexOf('.')).toLowerCase();
      const memberPath = join(directory, `member-${memberIndex}${extension}`);
      const input = await zip.openReadStreamPromise(entry);
      await pipeline(input, createWriteStream(memberPath, { flags: 'wx' }));
      members.set(normalizedName, {
        path: memberPath,
        size: entry.uncompressedSize,
      });
    }

    const shapeNames = [...members.keys()].filter((name) =>
      name.endsWith('.shp'),
    );
    if (shapeNames.length !== 1)
      throw new Error('Shapefile ZIP must contain exactly one .shp file');
    const shapeName = shapeNames[0];
    const stem = shapeName.slice(0, -4);
    const shape = members.get(shapeName)!;
    const index = members.get(`${stem}.shx`);
    const dbf = members.get(`${stem}.dbf`);
    if (!index || !dbf)
      throw new Error(
        'Shapefile ZIP must include matching .shx and .dbf files',
      );
    await validateShapeRecords(shape.path, shape.size);
    const cpg = members.get(`${stem}.cpg`);
    const encoding = cpg
      ? (await readFile(cpg.path, 'utf8')).trim() || 'windows-1252'
      : 'windows-1252';
    const prj = members.get(`${stem}.prj`);
    const projection = prj
      ? createWgs84Projection((await readFile(prj.path, 'utf8')).trim())
      : undefined;
    const reader = await openShapefile(shape.path, dbf.path, {
      encoding,
      highWaterMark: 64 * 1024,
    });
    let featureCount = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        featureCount += 1;
        if (featureCount > featureLimit)
          throw new Error(
            `geodata import contains more than ${featureLimit} features`,
          );
        const feature = projection
          ? reprojectFeature(result.value, projection)
          : result.value;
        const encodedBytes = Buffer.byteLength(JSON.stringify(feature));
        if (encodedBytes > MAX_RECORD_BYTES)
          throw new Error('a Shapefile feature exceeds the 16 MiB size limit');
        if (countVertices(feature) > MAX_FEATURE_VERTICES)
          throw new Error(
            `a source geometry exceeds the configured vertex limit (${MAX_FEATURE_VERTICES})`,
          );
        if (featureCount % 100 === 0) await heartbeat();
        yield feature;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (!featureCount)
      throw new Error('Shapefile archive contains no features');
  } finally {
    zip?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function createWgs84Projection(wkt: string): Converter {
  if (!wkt) throw new Error('Shapefile projection metadata is empty');
  try {
    return proj4(wkt, 'EPSG:4326');
  } catch (error) {
    throw new Error('Shapefile projection metadata is not supported', {
      cause: error,
    });
  }
}

function reprojectFeature(value: unknown, projection: Converter) {
  if (!isRecord(value) || !isRecord(value.geometry)) return value;
  reprojectGeometry(value.geometry, projection);
  return value;
}

function reprojectGeometry(
  geometry: Record<string, unknown>,
  projection: Converter,
) {
  if (geometry.type === 'GeometryCollection') {
    if (Array.isArray(geometry.geometries))
      for (const child of geometry.geometries)
        if (isRecord(child)) reprojectGeometry(child, projection);
    return;
  }
  if (Array.isArray(geometry.coordinates))
    geometry.coordinates = transformCoordinates(
      geometry.coordinates,
      projection,
    );
}

function transformCoordinates(
  value: unknown[],
  projection: Converter,
): unknown[] {
  if (
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number'
  )
    return projection.forward(value as number[]);
  return value.map((item) =>
    Array.isArray(item) ? transformCoordinates(item, projection) : item,
  );
}

async function validateShapeRecords(path: string, fileBytes: number) {
  if (fileBytes < 100) throw new Error('shapefile header is truncated');
  const file = await open(path, 'r');
  try {
    let position = 100;
    while (position < fileBytes) {
      const header = Buffer.alloc(8);
      const { bytesRead } = await file.read(header, 0, header.length, position);
      if (bytesRead !== header.length)
        throw new Error('shapefile record header is truncated');
      const contentBytes = header.readUInt32BE(4) * 2;
      if (contentBytes > MAX_RECORD_BYTES)
        throw new Error('a shapefile record exceeds the 16 MiB size limit');
      position += header.length + contentBytes;
      if (position > fileBytes)
        throw new Error('shapefile record data is truncated');
    }
  } finally {
    await file.close();
  }
}

function countVertices(value: unknown): number {
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

function positiveEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
