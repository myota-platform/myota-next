import { GeodataWorkerService } from './geodata-worker.service.js';

describe('GeodataWorkerService timer cleanup', () => {
  afterEach(() => vi.useRealTimers());

  function service() {
    return new GeodataWorkerService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      null,
    );
  }

  it('clears the heartbeat interval when a work item finishes early', async () => {
    vi.useFakeTimers();
    const worker = service();
    const internal = worker as unknown as {
      process: (...args: unknown[]) => Promise<void>;
      processWithHeartbeats: (
        definition: unknown,
        job: unknown,
        message: unknown,
      ) => Promise<void>;
    };
    internal.process = vi.fn().mockResolvedValue(undefined);

    await internal.processWithHeartbeats(
      {
        workType: 'geodata.import-preprocess.v1',
        heartbeatIntervalSeconds: 30,
        ackWaitSeconds: 300,
      },
      {},
      { working: vi.fn() },
    );

    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the heartbeat interval when work fails early', async () => {
    vi.useFakeTimers();
    const worker = service();
    const internal = worker as unknown as {
      process: (...args: unknown[]) => Promise<void>;
      processWithHeartbeats: (
        definition: unknown,
        job: unknown,
        message: unknown,
      ) => Promise<void>;
    };
    internal.process = vi
      .fn()
      .mockRejectedValue(new Error('processing failed'));

    await expect(
      internal.processWithHeartbeats(
        {
          workType: 'geodata.import-preprocess.v1',
          heartbeatIntervalSeconds: 30,
          ackWaitSeconds: 300,
        },
        {},
        { working: vi.fn() },
      ),
    ).rejects.toThrow('processing failed');

    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears a long retention wait when the worker shuts down', async () => {
    vi.useFakeTimers();
    const worker = service();
    const wait = (
      worker as unknown as { wait: (milliseconds: number) => Promise<void> }
    ).wait;
    const pending = wait.call(worker, 86_400_000);

    expect(vi.getTimerCount()).toBe(1);
    await worker.onModuleDestroy();
    await pending;

    expect(vi.getTimerCount()).toBe(0);
  });
});
