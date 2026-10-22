import { parseJsonWithExactIntegers } from '@app/platform/json-exact.js';
import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import { GeodataImporterService } from './geodata-importer.service.js';

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
          fetchSource: (url: string) => Promise<{ document: unknown }>;
        }
      ).fetchSource;

      await expect(
        fetchSource.call(importer, 'https://source.example.test/data.geojson'),
      ).rejects.toThrow('source did not return valid JSON');
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
      source: { url: sourceUrl, format: 'GEOJSON', sourceKey: 'scheduled' },
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
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://geodata.example.test/v1/geodata/refresh-schedules?page=1&pageSize=100',
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
    });
  });
});
