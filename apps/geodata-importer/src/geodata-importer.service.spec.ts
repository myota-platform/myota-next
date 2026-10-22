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
      JSON.stringify({
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
          JSON.stringify({ type: 'FeatureCollection', features: [feature] }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 'fixture-import-run', queued: true }),
          { status: 202 },
        ),
      );

    const importer = new GeodataImporterService();
    await importer.onModuleInit();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [sourceRequestUrl, sourceRequest] = fetchMock.mock.calls[0]!;
    expect(String(sourceRequestUrl)).toBe(sourceUrl);
    expect(sourceRequest).toMatchObject({
      headers: {
        accept: 'application/geo+json, application/json',
        'user-agent': 'MyOTA-geodata-importer/1.0',
      },
      redirect: 'manual',
    });

    const [apiRequestUrl, apiRequest] = fetchMock.mock.calls[1]!;
    expect(String(apiRequestUrl)).toBe(
      'http://geodata.example.test/v1/geodata/imports',
    );
    expect(apiRequest?.method).toBe('POST');
    const apiHeaders = new Headers(apiRequest?.headers);
    expect(apiHeaders.get('authorization')).toBe(
      'Bearer fixture-service-token',
    );
    expect(apiHeaders.get('idempotency-key')).toBe('fixture-import-key');
    expect(JSON.parse(String(apiRequest?.body))).toMatchObject({
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
