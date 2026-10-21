import { readFile } from 'node:fs/promises';
import { sourceFeatureHashOverride } from './geodata-source-feature-hash.js';
import { streamShapefileFeatures } from './geodata-shapefile-stream.js';

describe('streamShapefileFeatures', () => {
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
});
