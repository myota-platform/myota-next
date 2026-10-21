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
