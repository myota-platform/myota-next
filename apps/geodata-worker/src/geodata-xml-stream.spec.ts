import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { stringifyJsonWithBigInts } from '../../../libs/platform/src/json-bigint.js';
import { streamXmlFeatures } from './geodata-xml-stream.js';

async function* chunks(source: string, width = 17) {
  const bytes = Buffer.from(source);
  for (let offset = 0; offset < bytes.length; offset += width)
    yield bytes.subarray(offset, offset + width);
}

async function read(format: 'KML' | 'GPX', source: string) {
  const digest = createHash('sha256').update(source).digest('hex');
  return Array.fromAsync(
    streamXmlFeatures(format, chunks(source), digest, 5000, async () => {}),
  );
}

describe('streamXmlFeatures', () => {
  it('streams KML placemarks across input chunks', async () => {
    const features = await read(
      'KML',
      '<kml><Document><Placemark><name>Park</name><Point><coordinates>-5.99,37.39</coordinates></Point></Placemark></Document></kml>',
    );
    expect(features).toEqual([
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-5.99, 37.39] },
        properties: { name: 'Park' },
      },
    ]);
  });

  it('streams GPX waypoints and track segments with parsed attributes', async () => {
    const features = await read(
      'GPX',
      '<gpx><wpt lat="37.39" lon="-5.99"><name>Waypoint</name></wpt><trk><trkseg><trkpt lat="37.39" lon="-5.99"/><trkpt lat="37.40" lon="-5.98"/></trkseg></trk></gpx>',
    );
    expect(features).toEqual([
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-5.99, 37.39] },
        properties: { name: 'Waypoint' },
      },
      {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [-5.99, 37.39],
            [-5.98, 37.4],
          ],
        },
        properties: {},
      },
    ]);
  });

  it('rejects document types and source hash mismatches', async () => {
    await expect(
      read('KML', '<!DOCTYPE kml [<!ENTITY x "y">]><kml/>'),
    ).rejects.toThrow('document type');
    await expect(
      Array.fromAsync(
        streamXmlFeatures(
          'KML',
          chunks('<kml/>'),
          '0'.repeat(64),
          5,
          async () => {},
        ),
      ),
    ).rejects.toThrow('source hash does not match');
  });

  it.skipIf(process.platform !== 'linux')(
    'streams the Python 50,000-feature KML and GPX workloads within the RSS budget',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'myota-xml-rss-'));
      const featureCount = 50_000;
      async function* documents(format: 'KML' | 'GPX') {
        if (format === 'KML') yield '<kml><Document>';
        else yield '<gpx version="1.1" creator="MyOTA">';
        for (let start = 0; start < featureCount; start += 1000) {
          let chunk = '';
          for (let index = start; index < start + 1000; index++) {
            chunk +=
              format === 'KML'
                ? `<Placemark><name>fixture-${index}</name><Point><coordinates>-5.99,37.39</coordinates></Point></Placemark>`
                : `<wpt lat="37.39" lon="-5.99"><name>${index}</name></wpt>`;
          }
          yield chunk;
        }
        yield format === 'KML' ? '</Document></kml>' : '</gpx>';
      }

      try {
        const beforeMaxRssKb = process.resourceUsage().maxRSS;
        const startedAt = performance.now();
        let decodedTotal = 0;
        for (const format of ['KML', 'GPX'] as const) {
          const path = join(
            directory,
            `${format.toLowerCase()}.${format.toLowerCase()}`,
          );
          const hash = createHash('sha256');
          async function* hashedChunks() {
            for await (const text of documents(format)) {
              const bytes = Buffer.from(text);
              hash.update(bytes);
              yield bytes;
            }
          }
          await pipeline(
            Readable.from(hashedChunks()),
            createWriteStream(path, { flags: 'wx', mode: 0o600 }),
          );
          const expectedHash = hash.digest('hex');
          let formatCount = 0;
          for await (const _feature of streamXmlFeatures(
            format,
            createReadStream(path),
            expectedHash,
            featureCount,
            async () => undefined,
          )) {
            formatCount++;
          }
          expect(formatCount).toBe(featureCount);
          decodedTotal += formatCount;
        }
        const rssGrowthBytes =
          Math.max(0, process.resourceUsage().maxRSS - beforeMaxRssKb) * 1024;
        const elapsedMilliseconds = performance.now() - startedAt;
        expect(decodedTotal).toBe(featureCount * 2);
        expect(rssGrowthBytes).toBeLessThanOrEqual(96 * 1024 * 1024);
        console.info(
          stringifyJsonWithBigInts({
            qualification: 'kml-gpx-rss',
            formats: ['KML', 'GPX'],
            featureCountPerFormat: featureCount,
            totalFeatureCount: decodedTotal,
            elapsedMilliseconds: Math.round(elapsedMilliseconds),
            featuresPerSecond: Math.round(
              (decodedTotal * 1000) / elapsedMilliseconds,
            ),
            rssGrowthBytes,
            rssLimitBytes: 96 * 1024 * 1024,
          }),
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
