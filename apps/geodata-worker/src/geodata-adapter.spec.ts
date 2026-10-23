import { stringifyJsonWithBigInts } from '../../../libs/platform/src/json-bigint.js';
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

  it('reprojects the Python EPSG:25830 import fixture to WGS84', () => {
    const normalized = normalizeAdapterFeature('MANUAL', {
      properties: { name: 'Projected Sevilla point' },
      crs: 'EPSG:25830',
      geometry: {
        type: 'Point',
        coordinates: [235294.6497475471, 4142334.0458576377],
      },
    });

    const coordinates = (normalized.geometry as { coordinates: number[] })
      .coordinates;
    expect(coordinates[0]).toBeCloseTo(-5.99, 7);
    expect(coordinates[1]).toBeCloseTo(37.39, 7);
  });

  it.each([
    [23029, [500000, 4140000], [-9.001412412440352, 37.40488381004473]],
    [23030, [235000, 4140000], [-5.993670519717036, 37.367037324028914]],
    [23031, [430000, 4580000], [2.161899860653055, 41.36662235399315]],
  ] as const)(
    'matches PyProj Spanish IGN grid transforms for EPSG:%i imports',
    (epsg, coordinates, expected) => {
      const normalized = normalizeAdapterFeature('MANUAL', {
        properties: { name: `ED50 fixture ${epsg}` },
        crs: `EPSG:${epsg}`,
        geometry: { type: 'Point', coordinates: [...coordinates] },
      });

      const actual = (normalized.geometry as { coordinates: number[] })
        .coordinates;
      expect(actual[0]).toBeCloseTo(expected[0], 7);
      expect(actual[1]).toBeCloseTo(expected[1], 7);
    },
  );

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
    expect(normalized.properties.tags).not.toBe(normalized.properties);
    expect(() => stringifyJsonWithBigInts(normalized.properties)).not.toThrow();
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
