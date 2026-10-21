import { readFile } from 'node:fs/promises';
import { vi } from 'vitest';
import { sourceFeatureHashOverride } from './geodata-source-feature-hash.js';
import { decodeOsmPbfStream } from './geodata-osm-pbf.js';

describe('OSM PBF reference parity', () => {
  it('matches Python node, way, and multipolygon features and hashes', async () => {
    const source = await readFile(
      new URL('./fixtures/python-osm-parity.osm.pbf', import.meta.url),
    );
    async function* chunks() {
      yield source;
    }
    const features = [];
    for await (const feature of decodeOsmPbfStream(
      chunks(),
      'python-osm-parity.osm.pbf',
      20,
      '',
    )) {
      features.push(feature);
    }

    expect(features.map((feature) => feature.id)).toEqual([
      'node/1',
      'node/5',
      'way/10',
      'way/30',
      'way/20',
      'relation/40',
    ]);
    expect(features.map(sourceFeatureHashOverride)).toEqual([
      '13973b672ce2f69a0f07ba88e1ff9add2754e5995fda3e4c781ddcefd67256c1',
      'cbbfe3a0521aae6530b2b9ca787c5b8c862d37e97cd3302979f4c563475c50b1',
      '95009a3e4b97c4c277e90c2014eb7bf93d6e5d00f6e86bed52be9f9298cb0676',
      '696a996c26e7047f91d35d4ff1bcf06036d335b6e4b3b2b20f70a5199b3ac6bf',
      'b03a53cef6bc6111f92e0676d059c6ab3f07c4d94bad3c06b62b92765553c967',
      'ef6ceeccbf80adf546cda28a5f16adfb5b99f7ddc550072d61a3cde583147dde',
    ]);
    expect(features[0]).toMatchObject({
      type: 'Feature',
      id: 'node/1',
      properties: {
        leisure: 'park',
        name: 'Node Park',
        id: 'node/1',
        osm_id: 'node/1',
        sourceRef: 'node/1',
        featureType: 'node',
      },
      geometry: { type: 'Point', coordinates: [-5.99, 37.39] },
    });
    expect(features[5]).toMatchObject({
      id: 'relation/40',
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [-5.99, 37.39],
              [-5.98, 37.39],
              [-5.98, 37.4],
              [-5.99, 37.4],
              [-5.99, 37.39],
            ],
            [
              [-5.988, 37.392],
              [-5.988, 37.398],
              [-5.982, 37.398],
              [-5.982, 37.392],
              [-5.988, 37.392],
            ],
          ],
        ],
      },
      properties: {
        boundary: 'protected_area',
        name: 'Protected Relation',
      },
    });
  });

  it('reports the Python-compatible OSM area vertex-limit error', async () => {
    vi.resetModules();
    vi.stubEnv('MYOTA_IMPORT_MAX_FEATURE_VERTICES', '4');
    try {
      const { decodeOsmPbfStream } = await import('./geodata-osm-pbf.js');
      const source = await readFile(
        new URL('./fixtures/python-osm-parity.osm.pbf', import.meta.url),
      );
      async function* chunks() {
        yield source;
      }
      await expect(async () => {
        for await (const _feature of decodeOsmPbfStream(
          chunks(),
          'python-osm-parity.osm.pbf',
          20,
          '',
        )) {
          // Consume records until the first oversized area.
        }
      }).rejects.toThrow('an OSM area exceeds the configured vertex limit (4)');
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('reports the Python-compatible OSM way vertex-limit error', async () => {
    vi.resetModules();
    vi.stubEnv('MYOTA_IMPORT_MAX_FEATURE_VERTICES', '2');
    try {
      const { decodeOsmPbfStream } = await import('./geodata-osm-pbf.js');
      const source = await readFile(
        new URL('./fixtures/python-osm-parity.osm.pbf', import.meta.url),
      );
      async function* chunks() {
        yield source;
      }
      await expect(async () => {
        for await (const _feature of decodeOsmPbfStream(
          chunks(),
          'python-osm-parity.osm.pbf',
          20,
          '',
        )) {
          // Consume records until the first oversized way.
        }
      }).rejects.toThrow('an OSM way exceeds the configured vertex limit (2)');
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
