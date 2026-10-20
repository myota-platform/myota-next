import { BadRequestException } from '@nestjs/common';
import { SAXParser, type SAXOptions } from 'sax';

type Feature = {
  type: 'Feature';
  geometry: Record<string, unknown>;
  properties: Record<string, unknown>;
};

const maximumXmlBytes = 20 * 1024 * 1024;
const maximumFeatureBytes = 16 * 1024 * 1024;
const maximumFeatures = 100_000;
const maximumCoordinates = 250_000;

export function parseXmlImport(
  format: 'KML' | 'GPX',
  source: string,
): Feature[] {
  if (Buffer.byteLength(source, 'utf8') > maximumXmlBytes)
    throw new BadRequestException('XML import exceeds the 20 MiB limit');

  const parser = new SAXParser(true, {
    xmlns: true,
    position: false,
    strictEntities: true,
  } as SAXOptions & {
    strictEntities: boolean;
  });
  const features: Feature[] = [];
  const stack: string[] = [];
  let failure: Error | undefined;
  let textCapture: { name: string; chunks: string[] } | undefined;
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

  const fail = (message: string) => {
    failure ??= new Error(message);
  };
  const local = (name: string) => name.split(':').at(-1) ?? name;
  const addFeature = (feature: Feature) => {
    if (
      Buffer.byteLength(JSON.stringify(feature), 'utf8') > maximumFeatureBytes
    )
      fail(
        `a source feature exceeds the configured decoded-size limit (${maximumFeatureBytes} bytes)`,
      );
    features.push(feature);
    if (features.length > maximumFeatures)
      fail('XML import has too many features');
  };
  const readCoordinate = (raw: string) => {
    const values = raw.split(',');
    if (values.length < 2) return undefined;
    const longitude = Number(values[0]);
    const latitude = Number(values[1]);
    if (
      !values[0]?.trim() ||
      !values[1]?.trim() ||
      !Number.isFinite(longitude) ||
      !Number.isFinite(latitude)
    ) {
      fail('XML import contains an invalid coordinate');
      return undefined;
    }
    return [longitude, latitude];
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
      const attributes = tag.attributes as Record<string, string>;
      const longitude = Number(attributes.lon);
      const latitude = Number(attributes.lat);
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
        fail('GPX point has invalid longitude or latitude');
      } else {
        gpxPoint = {
          coordinates: [longitude, latitude],
          properties: {},
        };
      }
    } else if (name === 'trkseg') {
      trackPoints = [];
    } else if (name === 'trkpt' && trackPoints) {
      const attributes = tag.attributes as Record<string, string>;
      const longitude = Number(attributes.lon);
      const latitude = Number(attributes.lat);
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude))
        fail('GPX track point has invalid longitude or latitude');
      else {
        trackPoints.push([longitude, latitude]);
        if (trackPoints.length > maximumCoordinates)
          fail('XML import exceeds the 250000 coordinate limit per feature');
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
      textCapture = { name, chunks: [] };
  };
  parser.ontext = (text) => {
    textCapture?.chunks.push(text);
  };
  parser.oncdata = (text) => {
    textCapture?.chunks.push(text);
  };
  parser.onclosetag = (qualifiedName) => {
    const name = local(qualifiedName);
    const value =
      textCapture?.name === name ? textCapture.chunks.join('').trim() : '';
    if (format === 'KML' && placemark) {
      if (name === 'name' && value && placemark.name === undefined)
        placemark.name = value;
      if (name === 'coordinates' && value) {
        for (const token of value.replaceAll('\n', ' ').split(/\s+/)) {
          const point = readCoordinate(token);
          if (point) {
            placemark.points.push(point);
            if (placemark.inLine) placemark.lines.at(-1)?.push(point);
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
          const ring = points[0].every(
            (value, index) => value === points.at(-1)?.[index],
          )
            ? points
            : [...points, points[0]];
          geometry = { type: 'Polygon', coordinates: [ring] };
        } else if (placemark.geometryTypes.has('MultiGeometry')) {
          const lines = placemark.lines.filter((line) => line.length > 1);
          if (lines.length > 1)
            geometry = { type: 'MultiLineString', coordinates: lines };
          else if (lines.length === 1)
            geometry = { type: 'MultiLineString', coordinates: lines };
        }
        geometry ??= points.length
          ? { type: 'LineString', coordinates: points }
          : undefined;
        if (
          geometry &&
          countCoordinatePairs(geometry.coordinates) > maximumCoordinates
        )
          fail('XML import exceeds the 250000 coordinate limit per feature');
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

  const chunkSize = 64 * 1024;
  for (let offset = 0; offset < source.length && !failure;) {
    let end = Math.min(offset + chunkSize, source.length);
    const lastCodeUnit = source.charCodeAt(end - 1);
    if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end--;
    parser.write(source.slice(offset, end));
    offset = end;
  }
  if (!failure) parser.close();
  if (failure)
    throw new BadRequestException(
      `invalid ${format} document: ${failure.message}`,
    );
  if (!features.length)
    throw new BadRequestException(`${format} contains no supported features`);
  return features;
}

function countCoordinatePairs(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  if (
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number'
  )
    return 1;
  let count = 0;
  for (const item of value) {
    count += countCoordinatePairs(item);
    if (count > maximumCoordinates) return count;
  }
  return count;
}
