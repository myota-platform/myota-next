import { normalizeAdapterFeature } from './geodata-adapter.js';

describe('normalizeAdapterFeature projection compatibility', () => {
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
});
