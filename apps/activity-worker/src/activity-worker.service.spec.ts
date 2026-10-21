import { ActivityWorkerService } from './activity-worker.service.js';

describe('ActivityWorkerService invalid envelopes', () => {
  it('records no work type for an invalid envelope, matching the Python worker', async () => {
    const repository = {
      recordWorkDeadLetter: vi.fn().mockResolvedValue(undefined),
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
      term: vi.fn(),
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
    expect(message.term).toHaveBeenCalledOnce();
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
      ack: vi.fn(),
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
    expect(message.ack).toHaveBeenCalledOnce();
  });
});
