import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { open as openShapefile } from 'shapefile';
import {
  MAX_SHAPEFILE_UPLOAD_BYTES,
  MAX_IMPORT_FEATURE_BYTES,
  MAX_IMPORT_FEATURE_VERTICES,
  MAX_SHAPEFILE_EXPANDED_BYTES,
} from '@app/platform/import-limits.js';
import { createUploadSpoolDirectory } from '@app/platform/upload-spool.js';
import { canonicalPythonGeneratedJson } from '../../geodata/src/geodata-request-fingerprint.js';
import { setSourceFeatureHashOverride } from './geodata-source-feature-hash.js';

const MAX_ARCHIVE_MEMBERS = 100;
const MAX_RECORD_BYTES = MAX_IMPORT_FEATURE_BYTES;
const MAX_METADATA_BYTES = 1024 * 1024;

type ExtractedMember = { path: string; size: number; name: string };

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

  const directory = await createUploadSpoolDirectory('myota-shapefile-');
  let zip: yauzl.ZipFile | undefined;
  try {
    const archivePath = join(directory, 'source.zip');
    const hash = createHash('sha256');
    let archiveBytes = 0;
    let lastHeartbeatBytes = 0;
    const archiveLimit = MAX_SHAPEFILE_UPLOAD_BYTES;
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
      if (expandedBytes > MAX_SHAPEFILE_EXPANDED_BYTES)
        throw new Error(
          `Shapefile ZIP expands beyond the ${MAX_SHAPEFILE_EXPANDED_BYTES} byte limit`,
        );
      if (
        normalizedName.endsWith('.prj') &&
        entry.uncompressedSize > MAX_METADATA_BYTES
      )
        throw new Error('Shapefile projection metadata exceeds 1 MiB');
      const leafName = basename(name);
      if (
        !leafName ||
        name.endsWith('/') ||
        normalizedName.includes('__macosx/') ||
        leafName.startsWith('._') ||
        !/\.(shp|shx|dbf|prj)$/i.test(leafName)
      )
        continue;

      const extension = leafName.slice(leafName.lastIndexOf('.')).toLowerCase();
      const memberPath = join(directory, `member-${memberIndex}${extension}`);
      const input = await zip.openReadStreamPromise(entry);
      await pipeline(input, createWriteStream(memberPath, { flags: 'wx' }));
      members.set(normalizedName, {
        path: memberPath,
        size: entry.uncompressedSize,
        name,
      });
    }

    const shapeEntry = [...members.entries()].find(([, member]) =>
      member.name.toLowerCase().endsWith('.shp'),
    );
    if (!shapeEntry) throw new Error('Shapefile ZIP must contain a .shp file');
    const [shapeName, shape] = shapeEntry;
    const stem = shapeName.slice(0, -4);
    const index = members.get(`${stem}.shx`);
    const dbf = members.get(`${stem}.dbf`);
    if (!index || !dbf)
      throw new Error(
        'Shapefile ZIP must include matching .shx and .dbf files',
      );
    await validateShapeRecords(shape.path, shape.size);
    const filteredDbf = await filterDeletedDbfRecords(dbf.path, directory);
    const shapeRecordLimit = await getShapeRecordLimit(index.path);
    const recordLimit =
      filteredDbf.recordLimit === undefined
        ? undefined
        : Math.max(0, Math.min(filteredDbf.recordLimit, shapeRecordLimit));
    const prj = members.get(`${stem}.prj`);
    const projectionText = prj ? await readFile(prj.path, 'utf8') : '';
    const dbfRecords = await openDbfRecordReader(filteredDbf.path);
    let reader: Awaited<ReturnType<typeof openShapefile>>;
    try {
      reader = await openShapefile(shape.path, filteredDbf.path, {
        encoding: 'utf-8',
        highWaterMark: 64 * 1024,
      });
    } catch (error) {
      await dbfRecords.close();
      if (
        error instanceof Error &&
        error.message === 'unsupported shape type: 31'
      )
        throw new Error(
          'Shape type "MULTIPATCH" cannot be represented as GeoJSON.',
        );
      throw error;
    }
    let featureCount = 0;
    try {
      while (true) {
        if (recordLimit !== undefined && featureCount >= recordLimit) break;
        const result = await reader.read();
        if (result.done) break;
        featureCount += 1;
        if (featureCount > featureLimit)
          throw new Error(
            `geodata import contains more than ${featureLimit} features`,
          );
        if (result.value === null)
          throw new Error(
            'Shape type "NULL" cannot be represented as GeoJSON.',
          );
        const feature = result.value;
        if (isRecord(feature) && isRecord(feature.properties))
          Object.assign(
            feature.properties,
            await dbfRecords.exactIntegerProperties(featureCount - 1),
          );
        if (projectionText && isRecord(feature)) feature.crs = projectionText;
        const canonical = isRecord(feature)
          ? canonicalPythonGeneratedJson(
              feature,
              (path) =>
                (path[0] === 'geometry' && path[1] === 'coordinates') ||
                (path[0] === 'properties' &&
                  typeof path[1] === 'string' &&
                  dbfRecords.floatingProperties.has(path[1])),
            )
          : stringifyJsonWithBigInts(feature);
        const encodedBytes = Buffer.byteLength(canonical, 'utf8');
        if (encodedBytes > MAX_RECORD_BYTES)
          throw new Error(
            `a source feature exceeds the configured decoded-size limit (${MAX_IMPORT_FEATURE_BYTES} bytes)`,
          );
        if (countVertices(feature) > MAX_IMPORT_FEATURE_VERTICES)
          throw new Error(
            `a source geometry exceeds the configured vertex limit (${MAX_IMPORT_FEATURE_VERTICES})`,
          );
        if (isRecord(feature)) {
          setSourceFeatureHashOverride(
            feature,
            createHash('sha256').update(canonical, 'utf8').digest('hex'),
          );
        }
        if (featureCount % 100 === 0) await heartbeat();
        yield feature;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      await dbfRecords.close();
    }
    if (!featureCount)
      throw new Error('Shapefile archive contains no features');
  } finally {
    zip?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

/** PyShp omits deleted DBF rows before pairing records with shapes. */
async function filterDeletedDbfRecords(path: string, directory: string) {
  const input = await open(path, 'r');
  try {
    const header = Buffer.alloc(32);
    const headerRead = await input.read(header, 0, header.length, 0);
    if (headerRead.bytesRead !== header.length)
      return { path, recordLimit: undefined };

    const recordCount = header.readUInt32LE(4);
    const headerLength = header.readUInt16LE(8);
    const recordLength = header.readUInt16LE(10);
    const size = (await input.stat()).size;
    if (
      recordLength < 1 ||
      headerLength < 33 ||
      headerLength > size ||
      headerLength + recordCount * recordLength > size
    )
      return { path, recordLimit: undefined };

    const row = Buffer.alloc(recordLength);
    let hasDeletedRows = false;
    let activeCount = 0;
    for (let index = 0; index < recordCount; index++) {
      const result = await input.read(
        row,
        0,
        recordLength,
        headerLength + index * recordLength,
      );
      if (result.bytesRead !== recordLength)
        return { path, recordLimit: undefined };
      if (row[0] !== 0x20) hasDeletedRows = true;
      else activeCount++;
    }
    if (!hasDeletedRows) return { path, recordLimit: activeCount };

    const outputPath = join(directory, 'active-records.dbf');
    const output = await open(outputPath, 'wx');
    try {
      const outputHeader = Buffer.from(header);
      outputHeader.writeUInt32LE(activeCount, 4);
      const descriptors = Buffer.alloc(headerLength - header.length);
      const descriptorsRead = await input.read(
        descriptors,
        0,
        descriptors.length,
        header.length,
      );
      if (descriptorsRead.bytesRead !== descriptors.length)
        throw new Error('Shapefile DBF header is truncated');
      await writeFileHandle(output, outputHeader, 0);
      await writeFileHandle(output, descriptors, header.length);
      let outputPosition = headerLength;
      for (let index = 0; index < recordCount; index++) {
        const result = await input.read(
          row,
          0,
          recordLength,
          headerLength + index * recordLength,
        );
        if (result.bytesRead !== recordLength)
          throw new Error('Shapefile DBF record is truncated');
        if (row[0] !== 0x20) continue;
        await writeFileHandle(output, row, outputPosition);
        outputPosition += recordLength;
      }
      await writeFileHandle(output, Buffer.from([0x1a]), outputPosition);
    } finally {
      await output.close();
    }
    return { path: outputPath, recordLimit: activeCount };
  } finally {
    await input.close();
  }
}

async function openDbfRecordReader(path: string) {
  const file = await open(path, 'r');
  const header = Buffer.alloc(32);
  const headerRead = await file.read(header, 0, header.length, 0);
  if (headerRead.bytesRead !== header.length) {
    await file.close();
    throw new Error('Shapefile DBF header is truncated');
  }
  const headerLength = header.readUInt16LE(8);
  const recordLength = header.readUInt16LE(10);
  const floatingProperties = new Set<string>();
  const integerFields: { name: string; offset: number; length: number }[] = [];
  let position = 32;
  let recordOffset = 1;
  while (position + 32 <= headerLength) {
    const descriptor = Buffer.alloc(32);
    const result = await file.read(descriptor, 0, descriptor.length, position);
    if (result.bytesRead !== descriptor.length || descriptor[0] === 0x0d) break;
    const fieldName = descriptor
      .subarray(0, 11)
      .toString('ascii')
      .replace(/\0.*$/, '')
      .trimEnd();
    const fieldType = String.fromCharCode(descriptor[11] ?? 0);
    const fieldLength = descriptor[16] ?? 0;
    const decimalPlaces = descriptor[17] ?? 0;
    if (
      fieldName &&
      (fieldType === 'F' || (fieldType === 'N' && decimalPlaces > 0))
    )
      floatingProperties.add(fieldName);
    if (fieldName && fieldType === 'N' && decimalPlaces === 0)
      integerFields.push({
        name: fieldName,
        offset: recordOffset,
        length: fieldLength,
      });
    recordOffset += fieldLength;
    position += descriptor.length;
  }
  return {
    floatingProperties,
    async exactIntegerProperties(
      index: number,
    ): Promise<Record<string, bigint>> {
      const row = Buffer.alloc(recordLength);
      const result = await file.read(
        row,
        0,
        row.length,
        headerLength + index * recordLength,
      );
      if (result.bytesRead !== row.length || row[0] !== 0x20)
        throw new Error('Shapefile DBF record is truncated or deleted');
      const values: Record<string, bigint> = {};
      for (const field of integerFields) {
        const raw = row
          .subarray(field.offset, field.offset + field.length)
          .toString('ascii')
          .trim();
        if (!raw) continue;
        if (!/^[+-]?\d+$/.test(raw))
          throw new Error(
            `Shapefile DBF integer field '${field.name}' is invalid`,
          );
        values[field.name] = BigInt(raw);
      }
      return values;
    },
    close: () => file.close(),
  };
}

/** PyShp limits shape iteration to the number of records in the .shx file. */
async function getShapeRecordLimit(path: string) {
  const file = await open(path, 'r');
  try {
    const recordLength = Buffer.alloc(4);
    const result = await file.read(recordLength, 0, 4, 24);
    if (result.bytesRead !== 4)
      throw new Error('Shapefile index header is truncated');
    return Math.floor((recordLength.readInt32BE(0) * 2 - 100) / 8);
  } finally {
    await file.close();
  }
}

async function writeFileHandle(
  file: Awaited<ReturnType<typeof open>>,
  bytes: Buffer,
  position?: number,
) {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await file.write(
      bytes,
      offset,
      bytes.length - offset,
      position === undefined ? null : position + offset,
    );
    if (!result.bytesWritten) throw new Error('Could not write Shapefile DBF');
    offset += result.bytesWritten;
  }
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
        throw new Error(
          `a shapefile record exceeds the configured decoded-size limit (${MAX_IMPORT_FEATURE_BYTES} bytes)`,
        );
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
      if (vertices > MAX_IMPORT_FEATURE_VERTICES) return vertices;
    } else {
      for (const item of current) pending.push(item);
    }
  }
  return vertices;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
