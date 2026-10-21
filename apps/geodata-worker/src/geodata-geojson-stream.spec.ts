import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  readGeoJsonDocumentMetadata,
  streamGeoJsonFeatures,
} from './geodata-geojson-stream.js';

describe('GeoJSON streaming reference parity', () => {
  it.skipIf(process.platform !== 'linux')(
    'streams the Python 300,000-feature GeoJSON RSS workload',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'myota-geojson-rss-'));
      const sourcePath = join(directory, 'large.geojson');
      const featureCount = 300_000;
      async function* geoJson() {
        yield '{"type":"FeatureCollection","features":[';
        for (let start = 0; start < featureCount; start += 1000) {
          let chunk = '';
          for (
            let index = start;
            index < Math.min(start + 1000, featureCount);
            index++
          ) {
            if (index > 0) chunk += ',';
            chunk += `{"type":"Feature","properties":{"name":"fixture-${index}"},"geometry":{"type":"Point","coordinates":[-5.99,37.39]}}`;
          }
          yield chunk;
        }
        yield ']}';
      }

      try {
        await pipeline(
          Readable.from(geoJson()),
          createWriteStream(sourcePath, { flags: 'wx', mode: 0o600 }),
        );
        const beforeMaxRssKb = process.resourceUsage().maxRSS;
        const metadata = await readGeoJsonDocumentMetadata(
          createReadStream(sourcePath),
          async () => undefined,
        );
        let decoded = 0;
        for await (const _feature of streamGeoJsonFeatures(
          createReadStream(sourcePath),
          '',
          featureCount,
          {
            ...metadata,
            sourceFeatureHashOverrides: undefined,
          },
          async () => undefined,
        )) {
          decoded++;
        }
        const rssGrowthBytes =
          Math.max(0, process.resourceUsage().maxRSS - beforeMaxRssKb) * 1024;

        expect(metadata.rootType).toBe('FeatureCollection');
        expect(decoded).toBe(featureCount);
        expect(rssGrowthBytes).toBeLessThanOrEqual(96 * 1024 * 1024);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
