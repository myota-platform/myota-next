import { createHash } from 'node:crypto';
import { SAXParser, type SAXOptions } from 'sax';
import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import {
  MAX_IMPORT_FEATURE_BYTES,
  MAX_IMPORT_FEATURE_VERTICES,
  MAX_UPLOAD_BYTES,
} from '@app/platform/import-limits.js';
import { trimPythonWhitespace } from '@app/platform/python-strings.js';

type Feature = {
  type: 'Feature';
  geometry: Record<string, unknown>;
  properties: Record<string, unknown>;
};

const parserChunkBytes = 64 * 1024;
const maximumHeartbeatBytes = 32 * 1024 * 1024;

/** Stream KML placemarks or GPX waypoints and track segments from an uploaded object. */
export async function* streamXmlFeatures(
  format: 'KML' | 'GPX',
  source: AsyncIterable<Uint8Array>,
  sourceHash: string,
  featureLimit: number,
  heartbeat: () => Promise<void>,
): AsyncGenerator<Feature> {
  const parser = new SAXParser(true, {
    xmlns: true,
    position: false,
    strictEntities: true,
  } as SAXOptions & { strictEntities: boolean });
  const output: Feature[] = [];
  const stack: string[] = [];
  const digest = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let failure: Error | undefined;
  let textCapture:
    { name: string; chunks: string[]; sizeBytes: number } | undefined;
  let placemark:
    | {
        name?: string;
        points: number[][];
        lines: number[][][];
        inLine: boolean;
        geometryTypes: Set<string>;
      }
    | undefined;
  let gpxPoint:
    { coordinates: number[]; properties: Record<string, unknown> } | undefined;
  let trackPoints: number[][] | undefined;
  let sourceBytes = 0;
  let lastHeartbeatBytes = 0;
  let featureCount = 0;

  const fail = (message: string) => {
    failure ??= new Error(message);
  };
  const local = (name: string) => name.split(':').at(-1) ?? name;
  const addFeature = (feature: Feature) => {
    const encoded = stringifyJsonWithBigInts(feature) ?? 'null';
    if (Buffer.byteLength(encoded, 'utf8') > MAX_IMPORT_FEATURE_BYTES)
      fail(
        `a source feature exceeds the configured decoded-size limit (${MAX_IMPORT_FEATURE_BYTES} bytes)`,
      );
    featureCount++;
    if (featureCount > featureLimit)
      fail(`geodata import contains more than ${featureLimit} features`);
    output.push(feature);
  };
  const readCoordinate = (raw: string) => {
    const values = raw.split(',');
    if (values.length < 2) return undefined;
    const longitude = Number(values[0]);
    const latitude = Number(values[1]);
    if (
      !trimPythonWhitespace(values[0] ?? '') ||
      !trimPythonWhitespace(values[1] ?? '') ||
      !Number.isFinite(longitude) ||
      !Number.isFinite(latitude)
    ) {
      fail('XML import contains an invalid coordinate');
      return undefined;
    }
    return [longitude, latitude];
  };
  const countCoordinates = (value: unknown): number => {
    if (!Array.isArray(value)) return 0;
    if (
      value.length >= 2 &&
      typeof value[0] === 'number' &&
      typeof value[1] === 'number'
    )
      return 1;
    let count = 0;
    for (const child of value) {
      count += countCoordinates(child);
      if (count > MAX_IMPORT_FEATURE_VERTICES) return count;
    }
    return count;
  };

  parser.onerror = (error) => {
    failure ??= error;
  };
  parser.ondoctype = () => fail('XML imports must not contain a document type');
  parser.onopentag = (tag) => {
    const name = local(tag.name);
    stack.push(name);
    if (format === 'KML') {
      if (name === 'Placemark')
        placemark = {
          points: [],
          lines: [],
          inLine: false,
          geometryTypes: new Set(),
        };
      if (placemark && ['Point', 'Polygon', 'MultiGeometry'].includes(name))
        placemark.geometryTypes.add(name);
      if (placemark && name === 'LineString') {
        placemark.inLine = true;
        placemark.lines.push([]);
      }
    } else if (['wpt', 'rtept'].includes(name)) {
      const attributes = tag.attributes as Record<string, unknown>;
      const longitude = Number(attributeValue(attributes.lon));
      const latitude = Number(attributeValue(attributes.lat));
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude))
        fail('GPX point has invalid longitude or latitude');
      else gpxPoint = { coordinates: [longitude, latitude], properties: {} };
    } else if (name === 'trkseg') {
      trackPoints = [];
    } else if (name === 'trkpt' && trackPoints && stack.at(-2) === 'trkseg') {
      const attributes = tag.attributes as Record<string, unknown>;
      const longitude = Number(attributeValue(attributes.lon));
      const latitude = Number(attributeValue(attributes.lat));
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude))
        fail('GPX track point has invalid longitude or latitude');
      else {
        trackPoints.push([longitude, latitude]);
        if (trackPoints.length > MAX_IMPORT_FEATURE_VERTICES)
          fail(
            `XML import exceeds the ${MAX_IMPORT_FEATURE_VERTICES} coordinate limit per feature`,
          );
      }
    }
    if (
      (format === 'KML' && name === 'name' && stack.at(-2) === 'Placemark') ||
      (format === 'KML' && name === 'coordinates') ||
      (format === 'GPX' &&
        ['name', 'desc', 'type'].includes(name) &&
        gpxPoint &&
        ['wpt', 'rtept'].includes(stack.at(-2) ?? ''))
    )
      textCapture = { name, chunks: [], sizeBytes: 0 };
  };
  const captureText = (text: string) => {
    if (!textCapture || failure) return;
    const bytes = Buffer.byteLength(text, 'utf8');
    textCapture.sizeBytes += bytes;
    if (textCapture.sizeBytes > MAX_IMPORT_FEATURE_BYTES) {
      fail(
        `a source feature exceeds the configured decoded-size limit (${MAX_IMPORT_FEATURE_BYTES} bytes)`,
      );
      return;
    }
    textCapture.chunks.push(text);
  };
  parser.ontext = captureText;
  parser.oncdata = captureText;
  parser.onclosetag = (qualifiedName) => {
    const name = local(qualifiedName);
    const value =
      textCapture?.name === name
        ? trimPythonWhitespace(textCapture.chunks.join(''))
        : '';
    if (format === 'KML' && placemark) {
      if (name === 'name' && value && placemark.name === undefined)
        placemark.name = value;
      if (name === 'coordinates' && value) {
        for (const token of value.replaceAll('\n', ' ').split(/\s+/)) {
          const point = readCoordinate(token);
          if (point) {
            placemark.points.push(point);
            if (placemark.inLine) placemark.lines.at(-1)?.push(point);
            if (placemark.points.length > MAX_IMPORT_FEATURE_VERTICES)
              fail(
                `XML import exceeds the ${MAX_IMPORT_FEATURE_VERTICES} coordinate limit per feature`,
              );
          }
        }
      }
      if (name === 'LineString') placemark.inLine = false;
      if (name === 'Placemark') {
        const points = placemark.points;
        let geometry: Record<string, unknown> | undefined;
        if (placemark.geometryTypes.has('Point') && points.length)
          geometry = { type: 'Point', coordinates: points[0] };
        else if (placemark.geometryTypes.has('Polygon') && points.length) {
          const ring = points[0]!.every(
            (coordinate, index) => coordinate === points.at(-1)?.[index],
          )
            ? points
            : [...points, points[0]!];
          geometry = { type: 'Polygon', coordinates: [ring] };
        } else if (placemark.geometryTypes.has('MultiGeometry')) {
          const lines = placemark.lines.filter((line) => line.length > 1);
          if (lines.length)
            geometry = { type: 'MultiLineString', coordinates: lines };
        }
        geometry ??= points.length
          ? { type: 'LineString', coordinates: points }
          : undefined;
        if (
          geometry &&
          countCoordinates(geometry.coordinates) > MAX_IMPORT_FEATURE_VERTICES
        )
          fail(
            `XML import exceeds the ${MAX_IMPORT_FEATURE_VERTICES} coordinate limit per feature`,
          );
        if (geometry)
          addFeature({
            type: 'Feature',
            geometry,
            properties: placemark.name ? { name: placemark.name } : {},
          });
        placemark = undefined;
      }
    } else if (format === 'GPX') {
      if (gpxPoint && ['name', 'desc', 'type'].includes(name) && value)
        gpxPoint.properties[name] = value;
      if (gpxPoint && ['wpt', 'rtept'].includes(name)) {
        addFeature({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: gpxPoint.coordinates },
          properties: gpxPoint.properties,
        });
        gpxPoint = undefined;
      }
      if (name === 'trkseg') {
        if (trackPoints && trackPoints.length >= 2)
          addFeature({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: trackPoints },
            properties: {},
          });
        trackPoints = undefined;
      }
    }
    if (textCapture?.name === name) textCapture = undefined;
    stack.pop();
  };

  for await (const incoming of source) {
    const chunk = Buffer.isBuffer(incoming) ? incoming : Buffer.from(incoming);
    sourceBytes += chunk.length;
    if (sourceBytes > MAX_UPLOAD_BYTES)
      throw new Error('XML import source exceeds the configured upload limit');
    digest.update(chunk);
    try {
      for (let offset = 0; offset < chunk.length; offset += parserChunkBytes) {
        const text = decoder.decode(
          chunk.subarray(offset, offset + parserChunkBytes),
          { stream: true },
        );
        if (text) parser.write(text);
        if (failure) break;
        while (output.length) yield output.shift()!;
      }
    } catch (error) {
      failure ??= error instanceof Error ? error : new Error(String(error));
    }
    if (failure) break;
    if (sourceBytes - lastHeartbeatBytes >= maximumHeartbeatBytes) {
      await heartbeat();
      lastHeartbeatBytes = sourceBytes;
    }
  }
  if (!failure) {
    try {
      const remainder = decoder.decode();
      if (remainder) parser.write(remainder);
      parser.close();
    } catch (error) {
      failure ??= error instanceof Error ? error : new Error(String(error));
    }
  }
  if (!failure && digest.digest('hex') !== sourceHash)
    failure = new Error(
      'geodata import source hash does not match its queued record',
    );
  if (!failure && featureCount === 0)
    failure = new Error(`${format} contains no supported features`);
  if (failure)
    throw new Error(`invalid ${format} document: ${failure.message}`);
  while (output.length) yield output.shift()!;
}

function attributeValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'value' in value) {
    const raw = (value as { value?: unknown }).value;
    return typeof raw === 'string' ? raw : undefined;
  }
  return undefined;
}
