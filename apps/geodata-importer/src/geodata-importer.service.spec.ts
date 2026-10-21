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
