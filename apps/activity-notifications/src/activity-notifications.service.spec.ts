import { ActivityNotificationsService } from './activity-notifications.service.js';

describe('ActivityNotificationsService redelivery', () => {
  it('keeps database retries running when JetStream cannot extend the ACK', async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.startsWith('SELECT 1 FROM public.consumer_processed_event'))
          return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    let connectionAttempts = 0;
    const transientError = Object.assign(
      new Error('connection terminated unexpectedly'),
      { code: 'ECONNRESET' },
    );
    const pool = {
      connect: vi.fn(async () => {
        connectionAttempts += 1;
        if (connectionAttempts === 1) throw transientError;
        return client;
      }),
      query: vi.fn().mockResolvedValue({ rows: [{ count: '0' }] }),
    };
    const service = new ActivityNotificationsService(pool as never);
    const message = {
      data: new TextEncoder().encode(
        JSON.stringify({
          eventId: '33333333-3333-4333-8333-333333333333',
          eventType: 'identity.account.created.v1',
          payload: { accountId: 'account-1' },
        }),
      ),
      subject: 'myota.events.identity.account.created.v1',
      info: { deliveryCount: 1, streamSequence: 13 },
      working: vi.fn(() => {
        throw new Error('JetStream connection is unavailable');
      }),
      ackAck: vi.fn(async () => true),
      nak: vi.fn(),
    };

    await (
      service as unknown as { handle: (message: unknown) => Promise<void> }
    ).handle(message);

    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(message.working).toHaveBeenCalledOnce();
    expect(message.ackAck).toHaveBeenCalledOnce();
    expect(message.nak).not.toHaveBeenCalled();
    expect(
      statements.filter((sql) =>
        sql.startsWith('INSERT INTO public.activity_notification'),
      ),
    ).toHaveLength(1);
  });

  it('does not repeat notification writes when ACK confirmation is lost', async () => {
    let processed = false;
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.startsWith('SELECT 1 FROM public.consumer_processed_event'))
          return { rowCount: processed ? 1 : 0, rows: processed ? [{}] : [] };
        if (sql.startsWith('INSERT INTO public.consumer_processed_event'))
          processed = true;
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn().mockResolvedValue({ rows: [{ count: '0' }] }),
    };
    const service = new ActivityNotificationsService(pool as never);
    let ackAttempts = 0;
    const message = {
      data: new TextEncoder().encode(
        JSON.stringify({
          eventId: '22222222-2222-4222-8222-222222222222',
          eventType: 'identity.account.created.v1',
          payload: { accountId: 'account-1' },
        }),
      ),
      subject: 'myota.events.identity.account.created.v1',
      info: { deliveryCount: 1, streamSequence: 12 },
      ackAck: vi.fn(async () => {
        ackAttempts += 1;
        if (ackAttempts === 1) throw new Error('ack response lost');
        return true;
      }),
      nak: vi.fn(),
    };
    const handle = (
      service as unknown as { handle: (message: unknown) => Promise<void> }
    ).handle;

    await handle.call(service, message);
    await handle.call(service, message);

    expect(
      statements.filter((sql) =>
        sql.startsWith('INSERT INTO public.activity_notification'),
      ),
    ).toHaveLength(1);
    expect(
      statements.filter((sql) =>
        sql.startsWith('INSERT INTO public.consumer_processed_event'),
      ),
    ).toHaveLength(1);
    expect(message.ackAck).toHaveBeenCalledTimes(2);
    expect(message.nak).not.toHaveBeenCalled();
    expect(
      (service as unknown as { outcomes: Map<string, number> }).outcomes.get(
        'ack_unconfirmed',
      ),
    ).toBe(1);
  });

  it('uses the Python fallback for a falsey event type in a poison record', async () => {
    const values: unknown[][] = [];
    const client = {
      query: vi.fn(async (_sql: string, parameters: unknown[] = []) => {
        values.push(parameters);
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn().mockResolvedValue({ rows: [{ count: '1' }] }),
    };
    const service = new ActivityNotificationsService(pool as never);
    const message = {
      data: new TextEncoder().encode(
        JSON.stringify({
          eventId: '22222222-2222-4222-8222-222222222222',
          eventType: '',
        }),
      ),
      subject: 'myota.events.identity.account.created.v1',
      info: { deliveryCount: 1, streamSequence: 12 },
      ackAck: vi.fn(async () => true),
    };

    await (
      service as unknown as { handle: (message: unknown) => Promise<void> }
    ).handle(message);

    expect(values[1]?.[1]).toBe('unknown');
    expect(message.ackAck).toHaveBeenCalledOnce();
  });
});
