import { normalizeAdapterFeature } from './geodata-adapter.js';

describe('normalizeAdapterFeature projection compatibility', () => {
  it('uses Python dict semantics for iterable property pairs', () => {
    const normalized = normalizeAdapterFeature('MANUAL', {
      properties: [
        ['name', 'Pair Park'],
        ['sourceRef', 'pair-1'],
      ],
      geometry: null,
    });

    expect(normalized).toMatchObject({
      properties: {
        name: 'Pair Park',
        sourceRef: 'pair-1',
        attachments: [],
      },
      geometry: null,
    });
  });

  it('reprojects EPSG:3031 and preserves extra coordinate ordinates', () => {
    const normalized = normalizeAdapterFeature('GOVERNMENT_GIS', {
      properties: { name: 'Polar research site', sourceFormat: 'GEOJSON' },
      crs: 'EPSG:3031',
      geometry: {
        type: 'Point',
        coordinates: [500000, 5000000, 17],
      },
    });

    expect(normalized.geometry).toEqual({
      type: 'Point',
      coordinates: [5.710593137499643, -45.96789506692622, 17],
    });
  });

  it('marks OpenStreetMap records outside the required tag set for skipping', () => {
    const normalized = normalizeAdapterFeature('OSM', {
      id: 42,
      tags: { name: 'Unclassified feature', osm_id: 42, amenity: 'bench' },
    });

    expect(normalized.properties).toMatchObject({
      name: 'Unclassified feature',
      osm_id: 42,
      sourceRef: 42,
      attribution: '© OpenStreetMap contributors',
      matchesRequiredTag: false,
      skipReason: 'FILTERED_TAG',
    });
  });

  it('converts an ArcGIS feature service point and resolves a title alias', () => {
    const normalized = normalizeAdapterFeature('GOVERNMENT_GIS', {
      properties: {
        sourceFormat: 'ARCGIS_FEATURESERVER',
        OBJECTID: 91,
        title: 'Regional trailhead',
      },
      geometry: { x: 7.2, y: 46.1 },
    });

    expect(normalized).toEqual({
      properties: {
        sourceFormat: 'ARCGIS_FEATURESERVER',
        OBJECTID: 91,
        title: 'Regional trailhead',
        attachments: [],
        sourceRef: 91,
        sourceRecordType: 'local-government GIS feature',
        name: 'Regional trailhead',
      },
      geometry: { type: 'Point', coordinates: [7.2, 46.1] },
    });
  });

  it('rejects unsupported government GIS formats', () => {
    expect(() =>
      normalizeAdapterFeature('GOVERNMENT_GIS', {
        properties: { sourceFormat: 'CSV' },
        geometry: null,
      }),
    ).toThrow('unsupported government GIS format CSV');
  });

  it('formats integer-valued floating CRS identifiers like Python', () => {
    expect(() =>
      normalizeAdapterFeature('GOVERNMENT_GIS', {
        properties: { sourceFormat: 'GEOJSON' },
        crs: 1e21,
        geometry: { type: 'Point', coordinates: [1, 2] },
      }),
    ).toThrow('unsupported CRS EPSG:1000000000000000000000');
  });
});
