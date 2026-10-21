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
