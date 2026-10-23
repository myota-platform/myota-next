import { pythonDictionary } from '@app/platform/python-dictionary.js';
import { pythonTruthy } from '@app/platform/python-truthiness.js';

export function featuresFromDocument(document: unknown, format: string) {
  if (isRecord(document) && document.type === 'FeatureCollection')
    return pythonList(document.features);
  if (format === 'ARCGIS_FEATURESERVER' && isRecord(document)) {
    if (isRecord(document.error))
      throw new Error('ArcGIS source returned an error document');
    if (!Array.isArray(document.features))
      throw new Error('ArcGIS response has no features array');
    return document.features.map((item) => {
      if (!isRecord(item)) throw new Error('ArcGIS feature is invalid');
      const geometry = isRecord(item.geometry) ? item.geometry : {};
      const properties = pythonDictionary(
        pythonTruthy(item.attributes) ? item.attributes : {},
        'attributes',
      );
      let geoJsonGeometry: Record<string, unknown>;
      if (Array.isArray(geometry.rings))
        geoJsonGeometry = { type: 'Polygon', coordinates: geometry.rings };
      else if (Array.isArray(geometry.paths))
        geoJsonGeometry = {
          type: 'MultiLineString',
          coordinates: geometry.paths,
        };
      else if (isJsonNumber(geometry.x) && isJsonNumber(geometry.y))
        geoJsonGeometry = {
          type: 'Point',
          coordinates: [geometry.x, geometry.y],
        };
      else throw new Error('ArcGIS feature geometry is unsupported');
      return { type: 'Feature', properties, geometry: geoJsonGeometry };
    });
  }
  throw new Error(
    'source response must be a GeoJSON FeatureCollection or ArcGIS FeatureServer JSON',
  );
}

function pythonList(value: unknown): unknown[] {
  if (!pythonTruthy(value)) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return Array.from(value);
  if (isRecord(value)) return Object.keys(value);
  throw new TypeError('FeatureCollection features are not iterable');
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonNumber(value: unknown): value is number | bigint {
  return typeof value === 'number' || typeof value === 'bigint';
}
