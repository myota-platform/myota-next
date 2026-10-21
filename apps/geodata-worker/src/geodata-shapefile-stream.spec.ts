import { readFile } from 'node:fs/promises';
import { normalizeAdapterFeature } from './geodata-adapter.js';
import { sourceFeatureHashOverride } from './geodata-source-feature-hash.js';
import { streamShapefileFeatures } from './geodata-shapefile-stream.js';

describe('streamShapefileFeatures', () => {
  it('preserves PyShp MultiPointZ GeoJSON coordinates', async () => {
    const source = await readFile(
      new URL('./fixtures/python-multipointz-shapefile.zip', import.meta.url),
    );
    async function* chunks() {
      yield source;
    }
    const features: unknown[] = [];
    for await (const feature of streamShapefileFeatures(
      chunks(),
      'python-multipointz-shapefile.zip',
      '',
      10,
      async () => undefined,
    )) {
      features.push(feature);
    }

    expect(features).toHaveLength(1);
    expect(features[0]).toMatchObject({
      type: 'Feature',
      geometry: {
        type: 'MultiPoint',
        coordinates: [
          [1, 2],
          [5, 6],
        ],
      },
      properties: { name: 'Z values' },
    });
  });

  it('organizes nested PyShp polygon rings like the reference importer', async () => {
    const source = await readFile(
      new URL(
        './fixtures/python-polygon-nested-rings-shapefile.zip',
        import.meta.url,
      ),
    );
    async function* chunks() {
      yield source;
    }
    const features: unknown[] = [];
    for await (const feature of streamShapefileFeatures(
      chunks(),
      'python-polygon-nested-rings-shapefile.zip',
      '',
      10,
      async () => undefined,
    )) {
      features.push(feature);
    }

    expect(features).toHaveLength(1);
    expect(features[0]).toMatchObject({
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [0, 0],
              [0, 10],
              [10, 10],
              [10, 0],
              [0, 0],
            ],
            [
              [2, 2],
              [8, 2],
              [8, 8],
              [2, 8],
              [2, 2],
            ],
          ],
          [
            [
              [3, 3],
              [3, 4],
              [4, 4],
              [4, 3],
              [3, 3],
            ],
          ],
          [
            [
              [20, 0],
              [20, 10],
              [30, 10],
              [30, 0],
              [20, 0],
            ],
          ],
        ],
      },
      properties: { name: 'nested rings' },
    });
  });

  it('organizes nested PyShp polygon rings like the reference importer', async () => {
    const source = await readFile(
      new URL(
        './fixtures/python-polygon-nested-rings-shapefile.zip',
        import.meta.url,
      ),
    );
    async function* chunks() {
      yield source;
    }
    const features: unknown[] = [];
    for await (const feature of streamShapefileFeatures(
      chunks(),
      'python-polygon-nested-rings-shapefile.zip',
      '',
      10,
      async () => undefined,
    )) {
      features.push(feature);
    }

    expect(features).toHaveLength(1);
    expect(features[0]).toMatchObject({
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [0, 0],
              [0, 10],
              [10, 10],
              [10, 0],
              [0, 0],
            ],
            [
              [2, 2],
              [8, 2],
              [8, 8],
              [2, 8],
              [2, 2],
            ],
          ],
          [
            [
              [3, 3],
              [3, 4],
              [4, 4],
              [4, 3],
              [3, 3],
            ],
          ],
          [
            [
              [20, 0],
              [20, 10],
              [30, 10],
              [30, 0],
              [20, 0],
            ],
          ],
        ],
      },
      properties: { name: 'nested rings' },
    });
  });

  it.each([
    'python-point-shapefile.zip',
    'python-point-shapefile-uppercase.zip',
  ])(
    'matches Python PyShp feature and exact DBF integers for %s',
    async (filename) => {
      const source = await readFile(
        new URL(`./fixtures/${filename}`, import.meta.url),
      );
      async function* chunks() {
        yield source;
      }
      const features: unknown[] = [];
      for await (const feature of streamShapefileFeatures(
        chunks(),
        filename,
        '',
        10,
        async () => undefined,
      )) {
        features.push(feature);
      }

      expect(features).toHaveLength(1);
      const feature = features[0] as {
        type: string;
        geometry: { type: string; coordinates: number[] };
        properties: Record<string, unknown>;
        crs: string;
      };
      expect(feature).toMatchObject({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [7.2, 46.1] },
        properties: {
          source_id: 'fixture-1',
          wide_int: 9007199254740993n,
          decimal: 12.5,
        },
      });
      expect(feature.crs).toContain('AUTHORITY["EPSG","4326"]');
      expect(sourceFeatureHashOverride(feature)).toBe(
        '9d130b3d65973025cd866bc4115feb920acd9e7c8c95ee1b27dca8706d187bd2',
      );
    },
  );

  it('keeps projected source coordinates and hashes before adapter reprojection', async () => {
    const source = await readFile(
      new URL(
        './fixtures/python-point-shapefile-web-mercator.zip',
        import.meta.url,
      ),
    );
    async function* chunks() {
      yield source;
    }
    let feature: unknown;
    for await (const item of streamShapefileFeatures(
      chunks(),
      'python-point-shapefile-web-mercator.zip',
      '',
      10,
      async () => undefined,
    )) {
      feature = item;
    }

    expect(feature).toMatchObject({
      geometry: {
        type: 'Point',
        coordinates: [801500.3337115698, 5796388.797364682],
      },
    });
    expect(sourceFeatureHashOverride(feature as object)).toBe(
      '0d2d0991d3e8d62d376dcc2d6af1a03ec36655282839523901ed218c6bd9845f',
    );
    const normalized = normalizeAdapterFeature(
      'MANUAL',
      feature as Record<string, unknown>,
    ).geometry as { coordinates: number[] };
    expect(normalized.type).toBe('Point');
    expect(normalized.coordinates[0]).toBeCloseTo(7.2, 7);
    expect(normalized.coordinates[1]).toBeCloseTo(46.10000000000001, 7);
  });
});
