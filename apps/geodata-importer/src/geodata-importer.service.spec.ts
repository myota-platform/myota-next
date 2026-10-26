import { parseJsonWithExactIntegers } from '@app/platform/json-exact.js';
import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import { MAX_GEODATA_SOURCE_FETCH_BYTES } from '@app/platform/import-limits.js';
import { performance } from 'node:perf_hooks';
import { GeodataImporterService } from './geodata-importer.service.js';
import { featuresFromDocument } from './geodata-importer-document.js';

describe('GeodataImporterService timer cleanup', () => {
  afterEach(() => vi.useRealTimers());

  it('clears its polling delay when the importer shuts down', async () => {
    vi.useFakeTimers();
    const previousPollSeconds = process.env.GEODATA_IMPORTER_POLL_SECONDS;
    process.env.GEODATA_IMPORTER_POLL_SECONDS = '3600';
    try {
      const importer = new GeodataImporterService();
      const runLoop = (importer as unknown as { runLoop: () => Promise<void> })
        .runLoop;
      const loop = runLoop.call(importer);

      expect(vi.getTimerCount()).toBe(1);
      await importer.onModuleDestroy();
      await loop;

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      if (previousPollSeconds === undefined)
        delete process.env.GEODATA_IMPORTER_POLL_SECONDS;
      else process.env.GEODATA_IMPORTER_POLL_SECONDS = previousPollSeconds;
    }
  });
});

describe('GeodataImporterService source decoding', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const invalidDocuments = [
    {
      description: 'invalid UTF-8',
      bytes: Buffer.concat([
        Buffer.from('{"type":"FeatureCollection","features":[],"name":"'),
        Buffer.from([0xff]),
        Buffer.from('"}'),
      ]),
    },
    {
      description: 'a UTF-8 BOM',
      bytes: Buffer.from(
        '\uFEFF{"type":"FeatureCollection","features":[]}',
        'utf8',
      ),
    },
  ];

  it.each(invalidDocuments)(
    'rejects $description like Python does',
    async ({ bytes }) => {
      vi.stubEnv('GEODATA_SOURCE_ALLOWLIST', 'example.test');
      const importer = new GeodataImporterService();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(bytes, { status: 200 }),
      );
      const fetchSource = (
        importer as unknown as {
          fetchSource: (
            url: string,
            maximumBytes?: number,
          ) => Promise<{ document: unknown }>;
        }
      ).fetchSource;

      await expect(
        fetchSource.call(importer, 'https://source.example.test/data.geojson'),
      ).rejects.toThrow('source did not return valid JSON');
    },
  );

  it.each([
    {
      description: 'declared content length',
      response: () =>
        new Response('too large', {
          status: 200,
          headers: { 'content-length': '9' },
        }),
    },
    {
      description: 'streamed response bytes',
      response: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Buffer.from('12345'));
              controller.enqueue(Buffer.from('6789'));
              controller.close();
            },
          }),
        ),
    },
  ])('rejects oversized source by $description', async ({ response }) => {
    vi.stubEnv('GEODATA_SOURCE_ALLOWLIST', 'example.test');
    const importer = new GeodataImporterService();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response());
    const fetchSource = (
      importer as unknown as {
        fetchSource: (
          url: string,
          maximumBytes?: number,
        ) => Promise<{ document: unknown }>;
      }
    ).fetchSource;

    await expect(
      fetchSource.call(importer, 'https://source.example.test/data.geojson', 8),
    ).rejects.toThrow('source exceeds the configured fetch limit of 8 bytes');
  });

  it.each([
    { missing: 'license', source: { attribution: 'Regional GIS Office' } },
    { missing: 'attribution', source: { license: 'CC-BY-4.0' } },
  ])(
    'rejects a one-shot source without $missing metadata before fetching',
    async ({ missing, source }) => {
      vi.stubEnv('GEODATA_SOURCE_ALLOWLIST', 'example.test');
      vi.stubEnv(
        'GEODATA_IMPORT_SPEC',
        stringifyJsonWithBigInts({
          adapter: 'GOVERNMENT_GIS',
          source: {
            url: 'https://data.example.test/features.geojson',
            ...source,
          },
        }),
      );
      const fetchMock = vi.spyOn(globalThis, 'fetch');

      await expect(new GeodataImporterService().onModuleInit()).rejects.toThrow(
        `source requires ${missing} metadata`,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('fails closed when no source host is allowlisted', async () => {
    vi.stubEnv(
      'GEODATA_IMPORT_SPEC',
      stringifyJsonWithBigInts({
        adapter: 'GOVERNMENT_GIS',
        source: {
          url: 'https://data.example.test/features.geojson',
          license: 'CC-BY-4.0',
          attribution: 'Regional GIS Office',
        },
      }),
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(new GeodataImporterService().onModuleInit()).rejects.toThrow(
      'source URL must use HTTPS and an allowlisted host',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      maxBytes: 8,
      contentLength: '9',
      message: '8 bytes',
    },
    {
      maxBytes: MAX_GEODATA_SOURCE_FETCH_BYTES + 1,
      contentLength: String(MAX_GEODATA_SOURCE_FETCH_BYTES + 1),
      message: `${MAX_GEODATA_SOURCE_FETCH_BYTES} bytes`,
    },
  ])(
    'enforces source.maxBytes=$maxBytes without permitting a higher global cap',
    async ({ maxBytes, contentLength, message }) => {
      vi.stubEnv('GEODATA_SOURCE_ALLOWLIST', 'example.test');
      vi.stubEnv(
        'GEODATA_IMPORT_SPEC',
        stringifyJsonWithBigInts({
          adapter: 'GOVERNMENT_GIS',
          source: {
            url: 'https://data.example.test/features.geojson',
            license: 'CC-BY-4.0',
            attribution: 'Regional GIS Office',
            maxBytes,
          },
        }),
      );
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('too large', {
          status: 200,
          headers: { 'content-length': contentLength },
        }),
      );

      await expect(new GeodataImporterService().onModuleInit()).rejects.toThrow(
        `source exceeds the configured fetch limit of ${message}`,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
});

describe('GeodataImporterService one-shot imports', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('fetches an allowlisted source and submits a complete snapshot', async () => {
    const sourceUrl = 'https://data.example.test/geojson';
    const feature = {
      type: 'Feature',
      properties: { name: 'Fixture summit', sourceRef: 'summit-1' },
      geometry: { type: 'Point', coordinates: [7.2, 46.1] },
    };
    const source = {
      name: 'Importer fixture',
      sourceKey: 'fixture-source',
      url: sourceUrl,
      format: 'GEOJSON',
      license: 'CC-BY-4.0',
      attribution: 'Regional GIS Office',
    };
    vi.stubEnv('GEODATA_SOURCE_ALLOWLIST', 'example.test');
    vi.stubEnv(
      'GEODATA_IMPORT_SPEC',
      stringifyJsonWithBigInts({
        programmeSlug: 'fixture-programme',
        adapter: 'OSM',
        source,
        geodataUrl: 'http://geodata.example.test///',
        accessToken: 'fixture-service-token',
        idempotencyKey: 'fixture-import-key',
        disappearancePolicy: 'STALE',
      }),
    );
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          stringifyJsonWithBigInts({
            type: 'FeatureCollection',
            features: [feature],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          stringifyJsonWithBigInts({ id: 'fixture-import-run', queued: true }),
          { status: 202 },
        ),
      );

    const importer = new GeodataImporterService();
    await importer.onModuleInit();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [sourceRequestUrl, sourceRequest] = fetchMock.mock.calls[0]!;
    expect(sourceRequestUrl).toBeInstanceOf(URL);
    if (!(sourceRequestUrl instanceof URL))
      throw new Error('source fetch must use a parsed URL');
    expect(sourceRequestUrl.href).toBe(sourceUrl);
    expect(sourceRequest).toMatchObject({
      headers: {
        accept: 'application/geo+json, application/json',
        'user-agent': 'MyOTA-geodata-importer/1.0',
      },
      redirect: 'manual',
    });

    const [apiRequestUrl, apiRequest] = fetchMock.mock.calls[1]!;
    expect(apiRequestUrl).toBe(
      'http://geodata.example.test/v1/geodata/imports',
    );
    expect(apiRequest?.method).toBe('POST');
    const apiHeaders = new Headers(apiRequest?.headers);
    expect(apiHeaders.get('authorization')).toBe(
      'Bearer fixture-service-token',
    );
    expect(apiHeaders.get('idempotency-key')).toBe('fixture-import-key');
    expect(typeof apiRequest?.body).toBe('string');
    expect(
      parseJsonWithExactIntegers(apiRequest?.body as string),
    ).toMatchObject({
      programmeSlug: 'fixture-programme',
      adapter: 'OSM',
      source,
      features: [feature],
      completeSnapshot: true,
      disappearancePolicy: 'STALE',
      sourceFeatureHashOverrides: [expect.any(String)],
    });
    expect(importer.getOneShotResult()).toEqual({
      id: 'fixture-import-run',
      queued: true,
    });
  });
});

describe('GeodataImporterService scheduled imports', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('fetches a due allowlisted source and queues its complete schedule run', async () => {
    const scheduleId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const nextRunAt = '2020-01-01T00:00:00.000Z';
    const sourceUrl = 'https://data.example.test/scheduled.geojson';
    vi.stubEnv('GEODATA_SOURCE_ALLOWLIST', 'example.test');
    vi.stubEnv('MYOTA_AUTH_SIGNING_KEY', 'scheduled-import-test-key');
    vi.stubEnv('MYOTA_GEODATA_URL', 'http://geodata.example.test///');
    const schedule = {
      id: scheduleId,
      programmeSlug: 'fixture-programme',
      adapter: 'OSM',
      source: {
        url: sourceUrl,
        format: 'GEOJSON',
        sourceKey: 'scheduled',
        license: 'CC-BY-4.0',
        attribution: 'Regional GIS Office',
      },
      entityTypes: ['SOTA'],
      intervalSeconds: 86_400,
      lastRunAt: null,
      disappearancePolicy: 'REVIEW_REQUIRED',
      enabled: true,
      nextRunAt,
    };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          stringifyJsonWithBigInts({
            items: [schedule],
            page: 1,
            pageSize: 100,
            total: 1,
            nextPage: null,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          stringifyJsonWithBigInts({
            type: 'FeatureCollection',
            features: [],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));

    const importer = new GeodataImporterService();
    const poll = (importer as unknown as { poll: () => Promise<void> }).poll;
    await poll.call(importer);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [listRequestUrl, listRequest] = fetchMock.mock.calls[0]!;
    expect(listRequestUrl).toBeInstanceOf(URL);
    if (!(listRequestUrl instanceof URL))
      throw new Error('schedule listing must use a parsed URL');
    expect(listRequestUrl.href).toBe(
      'http://geodata.example.test/v1/geodata/refresh-schedules?page=1&pageSize=100',
    );
    expect(new Headers(listRequest?.headers).get('authorization')).toMatch(
      /^Bearer .+/,
    );
    const [sourceRequestUrl, sourceRequest] = fetchMock.mock.calls[1]!;
    expect(sourceRequestUrl).toBeInstanceOf(URL);
    if (!(sourceRequestUrl instanceof URL))
      throw new Error('scheduled source fetch must use a parsed URL');
    expect(sourceRequestUrl.href).toBe(sourceUrl);
    expect(sourceRequest).toMatchObject({ redirect: 'manual' });

    const [runRequestUrl, runRequest] = fetchMock.mock.calls[2]!;
    expect(runRequestUrl).toBe(
      `http://geodata.example.test/v1/geodata/refresh-schedules/${scheduleId}/run`,
    );
    expect(runRequest?.method).toBe('POST');
    const runHeaders = new Headers(runRequest?.headers);
    expect(runHeaders.get('authorization')).toMatch(/^Bearer .+/);
    expect(runHeaders.get('idempotency-key')).toBe(
      `geodata-schedule:${scheduleId}:${nextRunAt}`,
    );
    expect(parseJsonWithExactIntegers(runRequest?.body as string)).toEqual({
      features: [],
      sourceFeatureHashOverrides: [],
    });
  });

  it('reuses the schedule due-time idempotency key after an API failure', async () => {
    const scheduleId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const nextRunAt = '2020-01-01T00:00:00.000Z';
    const importer = new GeodataImporterService();
    const schedule = {
      id: scheduleId,
      nextRunAt,
      source: {
        url: 'https://data.example.test/scheduled.geojson',
        format: 'GEOJSON',
        license: 'CC-BY-4.0',
        attribution: 'Regional GIS Office',
      },
    } as never;
    vi.stubEnv('GEODATA_SOURCE_ALLOWLIST', 'example.test');
    vi.stubEnv('MYOTA_GEODATA_URL', 'http://geodata.example.test');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          stringifyJsonWithBigInts({
            type: 'FeatureCollection',
            features: [],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          stringifyJsonWithBigInts({
            type: 'FeatureCollection',
            features: [],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const runSchedule = (
      importer as unknown as {
        runSchedule: (value: unknown) => Promise<void>;
      }
    ).runSchedule;

    await expect(runSchedule.call(importer, schedule)).rejects.toThrow(
      'schedule run API returned HTTP 503',
    );
    await runSchedule.call(importer, schedule);

    const firstKey = new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get(
      'idempotency-key',
    );
    const retryKey = new Headers(fetchMock.mock.calls[3]?.[1]?.headers).get(
      'idempotency-key',
    );
    expect(firstKey).toBe(`geodata-schedule:${scheduleId}:${nextRunAt}`);
    expect(retryKey).toBe(firstKey);
  });

  it('backs off a failed source fetch for one poll interval', async () => {
    const schedule = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      programmeSlug: null,
      adapter: 'GOVERNMENT_GIS',
      source: {
        url: 'https://data.example.test/scheduled.geojson',
        license: 'CC-BY-4.0',
        attribution: 'Regional GIS Office',
      },
      entityTypes: [],
      intervalSeconds: 3600,
      lastRunAt: null,
      disappearancePolicy: 'REVIEW_REQUIRED',
      enabled: true,
      nextRunAt: '2020-01-01T00:00:00.000Z',
    };
    const page = () =>
      new Response(
        stringifyJsonWithBigInts({
          items: [schedule],
          page: 1,
          pageSize: 100,
          total: 1,
          nextPage: null,
        }),
        { status: 200 },
      );
    vi.stubEnv('GEODATA_SOURCE_ALLOWLIST', 'example.test');
    vi.stubEnv('MYOTA_GEODATA_URL', 'http://geodata.example.test');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(page());
    const importer = new GeodataImporterService();
    const poll = (importer as unknown as { poll: () => Promise<void> }).poll;

    await poll.call(importer);
    await poll.call(importer);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fetchMock.mock.calls.filter(
        ([url]) => url instanceof URL && url.hostname === 'data.example.test',
      ),
    ).toHaveLength(1);
  });

  it('rejects scheduled snapshots above the shared feature limit before posting', async () => {
    const importer = new GeodataImporterService();
    const schedule = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      source: {
        url: 'https://data.example.test/oversized.geojson',
        license: 'CC-BY-4.0',
        attribution: 'Regional GIS Office',
        maxFeatures: 5_001,
      },
    } as never;
    vi.stubEnv('GEODATA_SOURCE_ALLOWLIST', 'example.test');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        stringifyJsonWithBigInts({
          type: 'FeatureCollection',
          features: Array.from({ length: 5_001 }, (_, index) => ({
            type: 'Feature',
            properties: { name: `Feature ${index}` },
            geometry: { type: 'Point', coordinates: [0, 0] },
          })),
        }),
        { status: 200 },
      ),
    );
    const runSchedule = (
      importer as unknown as {
        runSchedule: (value: unknown) => Promise<void>;
      }
    ).runSchedule;

    await expect(runSchedule.call(importer, schedule)).rejects.toThrow(
      'source exceeds the 5000 feature limit',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('honors a source feature limit below the shared limit before posting', async () => {
    const importer = new GeodataImporterService();
    const schedule = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      source: {
        url: 'https://data.example.test/small-limit.geojson',
        license: 'CC-BY-4.0',
        attribution: 'Regional GIS Office',
        maxFeatures: 1,
      },
    } as never;
    vi.stubEnv('GEODATA_SOURCE_ALLOWLIST', 'example.test');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        stringifyJsonWithBigInts({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: { name: 'One' },
              geometry: { type: 'Point', coordinates: [0, 0] },
            },
            {
              type: 'Feature',
              properties: { name: 'Two' },
              geometry: { type: 'Point', coordinates: [0, 0] },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const runSchedule = (
      importer as unknown as {
        runSchedule: (value: unknown) => Promise<void>;
      }
    ).runSchedule;

    await expect(runSchedule.call(importer, schedule)).rejects.toThrow(
      'source exceeds the 1 feature limit',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('GeodataImporterService bounded source capacity qualification', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const enabled = process.env.GEODATA_IMPORTER_CAPACITY_QUALIFICATION === '1';
  it.skipIf(!enabled)(
    'parses the configured 5,000-feature limit for GeoJSON, WFS, and ArcGIS sources',
    async () => {
      const formats = ['GEOJSON', 'WFS', 'ARCGIS_FEATURESERVER'] as const;
      const featureCount = 5_000;
      const measurements: Array<Record<string, unknown>> = [];
      const rssBeforeBytes = process.resourceUsage().maxRSS * 1024;
      vi.stubEnv('GEODATA_SOURCE_ALLOWLIST', 'example.test');

      for (const format of formats) {
        const features = Array.from({ length: featureCount }, (_, index) =>
          format === 'ARCGIS_FEATURESERVER'
            ? {
                attributes: {
                  OBJECTID: index + 1,
                  name: `ArcGIS feature ${index}`,
                },
                geometry: { x: -5.99, y: 37.39 },
              }
            : {
                type: 'Feature',
                properties: { name: `${format} feature ${index}` },
                geometry: { type: 'Point', coordinates: [-5.99, 37.39] },
              },
        );
        const document =
          format === 'ARCGIS_FEATURESERVER'
            ? { features }
            : { type: 'FeatureCollection', features };
        const body = Buffer.from(stringifyJsonWithBigInts(document));
        expect(body.byteLength).toBeLessThanOrEqual(
          MAX_GEODATA_SOURCE_FETCH_BYTES,
        );
        const fetchMock = vi
          .spyOn(globalThis, 'fetch')
          .mockResolvedValueOnce(new Response(body, { status: 200 }));
        const importer = new GeodataImporterService();
        const fetchSource = (
          importer as unknown as {
            fetchSource: (url: string) => Promise<{ document: unknown }>;
          }
        ).fetchSource;
        const startedAt = performance.now();
        const response = await fetchSource.call(
          importer,
          'https://source.example.test/qualification.json',
        );
        const parsedFeatures = featuresFromDocument(response.document, format);
        const elapsedMilliseconds = performance.now() - startedAt;
        expect(parsedFeatures).toHaveLength(featureCount);
        measurements.push({
          format,
          featureCount: parsedFeatures.length,
          sourceBytes: body.byteLength,
          elapsedMilliseconds: Math.round(elapsedMilliseconds),
        });
        fetchMock.mockRestore();
      }

      const peakProcessRssGrowthBytes = Math.max(
        0,
        process.resourceUsage().maxRSS * 1024 - rssBeforeBytes,
      );
      expect(peakProcessRssGrowthBytes).toBeLessThanOrEqual(512 * 1024 * 1024);
      console.info(
        stringifyJsonWithBigInts({
          qualification: 'geodata-scheduled-source-capacity',
          measuredAt: new Date().toISOString(),
          environment: {
            node: process.version,
            cpuLimitCores: 1,
            memoryLimitBytes: 1024 ** 3,
            maximumSourceBytes: MAX_GEODATA_SOURCE_FETCH_BYTES,
            maximumImportFeatures: featureCount,
          },
          formats: measurements,
          peakProcessRssGrowthBytes,
        }),
      );
    },
    10 * 60 * 1000,
  );
});
