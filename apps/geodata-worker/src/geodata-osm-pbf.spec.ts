import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { vi } from 'vitest';
import { sourceFeatureHashOverride } from './geodata-source-feature-hash.js';
import { decodeOsmPbfStream } from './geodata-osm-pbf.js';

const execFileAsync = promisify(execFile);

async function readProcessTreeRssBytes(rootPid: number): Promise<number> {
  const pending = [rootPid];
  let total = 0;
  while (pending.length) {
    const pid = pending.pop();
    if (pid === undefined) continue;
    try {
      const [status, children] = await Promise.all([
        readFile(`/proc/${pid}/status`, 'utf8'),
        readFile(`/proc/${pid}/task/${pid}/children`, 'utf8'),
      ]);
      const residentKb = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1];
      if (residentKb) total += Number(residentKb) * 1024;
      pending.push(...children.trim().split(/\s+/).filter(Boolean).map(Number));
    } catch {
      // A short-lived subprocess may exit between reading its parent and it.
    }
  }
  return total;
}

async function measureOsmPbfRssGrowth(featureCount: number) {
  const directory = await mkdtemp(join(tmpdir(), 'myota-osm-rss-'));
  const xmlPath = join(directory, 'many-parks.osm');
  const pbfPath = join(directory, 'many-parks.osm.pbf');
  async function* osmXml() {
    yield '<?xml version="1.0" encoding="UTF-8"?><osm version="0.6" generator="myota-parity">';
    for (let start = 1; start <= featureCount; start += 1000) {
      let chunk = '';
      for (
        let id = start;
        id < Math.min(start + 1000, featureCount + 1);
        id++
      ) {
        const longitude = -5.99 + (id % 100) / 100_000;
        chunk += `<node id="${id}" lat="37.39" lon="${longitude}"><tag k="leisure" v="park"/></node>`;
      }
      yield chunk;
    }
    yield '</osm>';
  }

  try {
    await pipeline(
      Readable.from(osmXml()),
      createWriteStream(xmlPath, { flags: 'wx', mode: 0o600 }),
    );
    await execFileAsync('osmium', [
      'cat',
      xmlPath,
      '--output',
      pbfPath,
      '--output-format',
      'pbf',
    ]);

    const beforeRssBytes = await readProcessTreeRssBytes(process.pid);
    let peakRssBytes = beforeRssBytes;
    let sampling = true;
    const sample = (async () => {
      while (sampling) {
        peakRssBytes = Math.max(
          peakRssBytes,
          await readProcessTreeRssBytes(process.pid),
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();
    let decoded = 0;
    try {
      for await (const _feature of decodeOsmPbfStream(
        createReadStream(pbfPath),
        'many-parks.osm.pbf',
        featureCount,
        '',
      )) {
        decoded++;
      }
    } finally {
      sampling = false;
      await sample;
      peakRssBytes = Math.max(
        peakRssBytes,
        await readProcessTreeRssBytes(process.pid),
      );
    }
    return { decoded, rssGrowthBytes: peakRssBytes - beforeRssBytes };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

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

  describe.skipIf(process.platform !== 'linux')(
    'PBF process-tree memory bounds',
    () => {
      it.each([
        { featureCount: 50_000, rssLimitBytes: 96 * 1024 * 1024 },
        { featureCount: 250_000, rssLimitBytes: 192 * 1024 * 1024 },
      ])(
        'decodes $featureCount features within its RSS growth limit',
        async ({ featureCount, rssLimitBytes }) => {
          const { decoded, rssGrowthBytes } =
            await measureOsmPbfRssGrowth(featureCount);
          expect(decoded).toBe(featureCount);
          expect(rssGrowthBytes).toBeLessThanOrEqual(rssLimitBytes);
        },
        120_000,
      );
    },
  );
});
