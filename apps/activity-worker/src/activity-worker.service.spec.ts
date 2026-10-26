import { ActivityWorkerService } from './activity-worker.service.js';

describe('ActivityWorkerService invalid envelopes', () => {
  it('confirms invalid-envelope settlement after recording its dead letter', async () => {
    const steps: string[] = [];
    const repository = {
      recordWorkDeadLetter: vi.fn(async () => {
        steps.push('dead-letter');
      }),
    };
    const service = new ActivityWorkerService(
      repository as never,
      {} as never,
      null,
    );
    const message = {
      subject: 'myota.work.activity.qso-ingestion.v1',
      data: new TextEncoder().encode('{"workId":"invalid"}'),
      info: { deliveryCount: 2 },
      ackAck: vi.fn(async () => {
        steps.push('ack');
        return true;
      }),
    };
    const definition = {
      kind: 'QSO_INGESTION',
      workType: 'activity.qso-ingestion.v1',
      subject: message.subject,
      durable: 'activity-qso-ingestion-v1',
      consumer: {},
      maxPending: 4,
    };

    await (
      service as unknown as {
        handle: (definition: unknown, message: unknown) => Promise<void>;
      }
    ).handle(definition, message);

    expect(repository.recordWorkDeadLetter).toHaveBeenCalledWith(
      message.subject,
      null,
      null,
      2,
      'invalid_envelope',
    );
    expect(message.ackAck).toHaveBeenCalledOnce();
    expect(steps).toEqual(['dead-letter', 'ack']);
  });
});

describe('ActivityWorkerService work command metadata', () => {
  it('accepts the 150-character correlation ID allowed by the work schema', async () => {
    const workId = 'd4cb7610-6077-4b33-93d7-fefdd3c4a2a1';
    const repository = {
      claimWorkJob: vi.fn().mockResolvedValue(null),
      getWorkJobState: vi.fn().mockResolvedValue({
        id: workId,
        kind: 'QSO_INGESTION',
        status: 'SUCCEEDED',
        retryAfterSeconds: 0,
        leaseRemainingSeconds: 0,
      }),
      recordWorkDeadLetter: vi.fn(),
    };
    const service = new ActivityWorkerService(
      repository as never,
      {} as never,
      null,
    );
    const subject = 'myota.work.activity.qso-ingestion.v1';
    const message = {
      subject,
      data: new TextEncoder().encode(
        JSON.stringify({
          envelopeVersion: 1,
          workId,
          workType: 'activity.qso-ingestion.v1',
          createdAt: '2026-10-21T00:00:00Z',
          producer: 'activity-service',
          aggregate: { type: 'activity_job', id: workId },
          payload: { jobId: workId },
          correlationId: 'x'.repeat(150),
        }),
      ),
      info: { deliveryCount: 1 },
      ackAck: vi.fn(async () => true),
    };
    const definition = {
      kind: 'QSO_INGESTION',
      workType: 'activity.qso-ingestion.v1',
      subject,
      durable: 'activity-qso-ingestion-v1',
      consumer: {},
      maxPending: 4,
    };

    await (
      service as unknown as {
        handle: (definition: unknown, message: unknown) => Promise<void>;
      }
    ).handle(definition, message);

    expect(repository.recordWorkDeadLetter).not.toHaveBeenCalled();
    expect(message.ackAck).toHaveBeenCalledOnce();
  });
});

describe('ActivityWorkerService terminal settlement recovery', () => {
  it('dead-letters work after the durable job attempt limit', async () => {
    const workId = 'd4cb7610-6077-4b33-93d7-fefdd3c4a2a1';
    const subject = 'myota.work.activity.adif-import.v1';
    const repository = {
      claimWorkJob: vi.fn().mockResolvedValue({
        id: workId,
        kind: 'ADIF_IMPORT',
        payload: { importId: 'test-import' },
        attempts: 8,
        leaseToken: 'lease-8',
      }),
      process: vi.fn().mockRejectedValue(new Error('invalid ADIF data')),
      failWorkJob: vi.fn().mockResolvedValue(undefined),
      retryWorkJob: vi.fn(),
    };
    const service = new ActivityWorkerService(
      repository as never,
      {} as never,
      null,
    );
    const workType = 'activity.adif-import.v1';
    const message = {
      subject,
      data: new TextEncoder().encode(
        JSON.stringify({
          envelopeVersion: 1,
          workId,
          workType,
          createdAt: '2026-10-21T00:00:00Z',
          producer: 'activity-service',
          aggregate: { type: 'activity_job', id: workId },
          payload: { jobId: workId },
        }),
      ),
      info: { deliveryCount: 1 },
      ackAck: vi.fn().mockResolvedValue(true),
      nak: vi.fn(),
      working: vi.fn(),
    };
    const definition = {
      kind: 'ADIF_IMPORT',
      workType,
      subject,
      durable: 'activity-adif-import-v1',
      consumer: {},
      maxPending: 4,
    };

    await (
      service as unknown as {
        handle: (definition: unknown, message: unknown) => Promise<void>;
      }
    ).handle(definition, message);

    expect(repository.failWorkJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: workId, attempts: 8 }),
      expect.any(Error),
      subject,
      workType,
      1,
    );
    expect(repository.retryWorkJob).not.toHaveBeenCalled();
    expect(message.ackAck).toHaveBeenCalledOnce();
    expect(message.nak).not.toHaveBeenCalled();
  });

  it('retries an unconfirmed terminal ACK and safely handles redelivery', async () => {
    const workId = 'd4cb7610-6077-4b33-93d7-fefdd3c4a2a1';
    const subject = 'myota.work.activity.statistics-rebuild.v1';
    const repository = {
      claimWorkJob: vi
        .fn()
        .mockResolvedValueOnce({
          id: workId,
          kind: 'STATISTICS_REBUILD',
          payload: { programmeSlug: 'recovery' },
          attempts: 8,
          leaseToken: 'lease-8',
        })
        .mockResolvedValueOnce(null),
      getWorkJobState: vi.fn().mockResolvedValue({
        id: workId,
        kind: 'STATISTICS_REBUILD',
        status: 'FAILED',
        retryAfterSeconds: 0,
        leaseRemainingSeconds: 0,
      }),
      process: vi
        .fn()
        .mockRejectedValue(new Error('terminal processing error')),
      failWorkJob: vi.fn().mockResolvedValue(undefined),
    };
    const service = new ActivityWorkerService(
      repository as never,
      {} as never,
      null,
    );
    vi.spyOn(
      service as unknown as {
        wait: (milliseconds: number) => Promise<void>;
      },
      'wait',
    ).mockResolvedValue(undefined);
    const encodedEnvelope = new TextEncoder().encode(
      JSON.stringify({
        envelopeVersion: 1,
        workId,
        workType: 'activity.statistics-rebuild.v1',
        createdAt: '2026-10-21T00:00:00Z',
        producer: 'activity-service',
        aggregate: { type: 'activity_job', id: workId },
        payload: { jobId: workId },
      }),
    );
    const firstDelivery = {
      subject,
      data: encodedEnvelope,
      info: { deliveryCount: 8 },
      working: vi.fn(),
      ackAck: vi.fn().mockResolvedValue(false),
      nak: vi.fn(),
    };
    const redelivery = {
      subject,
      data: encodedEnvelope,
      info: { deliveryCount: 9 },
      working: vi.fn(),
      ackAck: vi.fn().mockResolvedValue(true),
      nak: vi.fn(),
    };
    const definition = {
      kind: 'STATISTICS_REBUILD',
      workType: 'activity.statistics-rebuild.v1',
      subject,
      durable: 'activity-statistics-rebuild-v1',
      consumer: {},
      maxPending: 4,
    };
    const handle = (message: unknown) =>
      (
        service as unknown as {
          handle: (definition: unknown, message: unknown) => Promise<void>;
        }
      ).handle(definition, message);

    await handle(firstDelivery);
    await handle(redelivery);

    expect(repository.failWorkJob).toHaveBeenCalledOnce();
    expect(repository.getWorkJobState).toHaveBeenCalledOnce();
    expect(firstDelivery.ackAck).toHaveBeenCalledTimes(9);
    expect(firstDelivery.working).toHaveBeenCalledTimes(8);
    expect(redelivery.ackAck).toHaveBeenCalledOnce();
    expect(repository.process).toHaveBeenCalledOnce();
  });
});

describe('ActivityWorkerService timer cleanup', () => {
  afterEach(() => vi.useRealTimers());

  it('clears the heartbeat interval when a job finishes early', async () => {
    vi.useFakeTimers();
    const repository = { process: vi.fn().mockResolvedValue(undefined) };
    const service = new ActivityWorkerService(
      repository as never,
      {} as never,
      null,
    );
    const job = {
      id: 'job-1',
      kind: 'QSO_INGESTION',
      payload: {},
      attempts: 1,
      leaseToken: 'lease-1',
    };
    const message = { working: vi.fn() };

    await (
      service as unknown as {
        processWithHeartbeats: (
          job: unknown,
          message: unknown,
        ) => Promise<void>;
      }
    ).processWithHeartbeats(job, message);

    expect(vi.getTimerCount()).toBe(0);
    expect(repository.process).toHaveBeenCalledOnce();
  });

  it('clears a long retention wait when the worker shuts down', async () => {
    vi.useFakeTimers();
    const service = new ActivityWorkerService({} as never, {} as never, null);
    const wait = (
      service as unknown as { wait: (milliseconds: number) => Promise<void> }
    ).wait;
    const pending = wait.call(service, 86_400_000);

    expect(vi.getTimerCount()).toBe(1);
    await service.onModuleDestroy();
    await pending;

    expect(vi.getTimerCount()).toBe(0);
  });
});
