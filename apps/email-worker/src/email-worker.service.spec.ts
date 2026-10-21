import type { JsMsg } from '@nats-io/jetstream';
import { EmailWorkerService } from './email-worker.service.js';
import {
  parseEmailCommand,
  renderEmailMessage,
  type EmailCommand,
} from './email-command.js';

const workId = 'd62842cf-2282-4f86-9890-a3b29745cf11';
const recipientAccountId = '566b8475-bda2-4a2d-8ab8-d7a9a93c0041';

function command(
  templateId = 'account-created-participant.v1',
  templateData: Record<string, unknown> = { displayName: '<Alice & Bob>' },
) {
  return {
    envelopeVersion: 1,
    workId,
    workType: 'email.send.v1',
    createdAt: '2026-10-14t12:00:00Z',
    producer: 'myota-identity',
    payload: { recipientAccountId, templateId, templateData },
  };
}

type WorkerHarness = {
  handle(message: JsMsg): Promise<void>;
  claim(parsed: EmailCommand): Promise<string>;
  resolveRecipient(accountId: string): Promise<string>;
  markDelivered(id: string): Promise<void>;
  retry(id: string): Promise<number>;
  deadLetter(id: string | null, code: string): Promise<void>;
  telemetry: {
    startDeliverySpan(
      templateId: string,
      carrier: Record<string, string>,
    ): undefined;
    smtpResult(success: boolean): void;
    observeSmtpDuration(templateId: string, seconds: number): void;
    record(outcome: string, templateId: string): void;
    observeDuration(templateId: string, seconds: number): void;
    recordLog(
      severity: string,
      message: string,
      attributes: Record<string, string>,
    ): void;
  };
  transporter: { sendMail(message: unknown): Promise<void> };
  sender: { address: string; displayName: string };
  logger: { warn(message: string): void; error(message: string): void };
};

function createWorker(
  events: string[],
  options: {
    claimState?: string;
    smtpError?: Error;
    retryAttempts?: number;
  } = {},
) {
  return Object.assign(
    Object.create(EmailWorkerService.prototype) as WorkerHarness,
    {
      claim: async (_parsed: EmailCommand) => {
        events.push('claim');
        return options.claimState ?? 'CLAIMED';
      },
      resolveRecipient: async (_accountId: string) => {
        events.push('identity');
        return 'alice@example.test';
      },
      markDelivered: async (_id: string) => {
        events.push('delivered');
      },
      retry: async (_id: string) => {
        events.push('retry');
        return options.retryAttempts ?? 1;
      },
      deadLetter: async (_id: string | null, code: string) => {
        events.push(`dead-letter:${code}`);
      },
      telemetry: {
        startDeliverySpan: () => undefined,
        smtpResult: () => undefined,
        observeSmtpDuration: () => undefined,
        record: () => undefined,
        observeDuration: () => undefined,
        recordLog: () => undefined,
      },
      transporter: {
        sendMail: async (_message: unknown) => {
          events.push('smtp');
          if (options.smtpError) throw options.smtpError;
        },
      },
      sender: { address: 'noreply@example.test', displayName: 'MyOTA' },
      logger: {
        warn: (message: string) => events.push(`warn:${message}`),
        error: (message: string) => events.push(`error:${message}`),
      },
    },
  );
}

function deliveryMessage(events: string[], deliveryCount = 1): JsMsg {
  return {
    data: Buffer.from(JSON.stringify(command())),
    info: { deliveryCount },
    ack: () => events.push('ack'),
    nak: (delay?: number) => events.push(`nak:${delay ?? 0}`),
    term: () => events.push('term'),
  } as unknown as JsMsg;
}

describe('email worker Python compatibility', () => {
  it('parses allowlisted participant and administrator commands', () => {
    const participant = parseEmailCommand(
      Buffer.from(JSON.stringify(command())),
    );
    const administrator = parseEmailCommand(
      Buffer.from(
        JSON.stringify(
          command('account-created-administrator.v1', {
            createdAccountName: 'New Admin',
            createdAccountRole: 'ADMINISTRATOR',
          }),
        ),
      ),
    );

    expect(participant).toEqual({
      workId,
      recipientAccountId,
      templateId: 'account-created-participant.v1',
      templateData: { displayName: '<Alice & Bob>' },
    });
    expect(administrator.templateId).toBe('account-created-administrator.v1');
  });

  it('rejects arbitrary recipient data, unknown templates, and BOM JSON', () => {
    const addressLeak = command();
    addressLeak.payload.templateData.emailAddress = 'alice@example.test';
    expect(() =>
      parseEmailCommand(Buffer.from(JSON.stringify(addressLeak))),
    ).toThrow('invalid participant email data');

    expect(() =>
      parseEmailCommand(
        Buffer.from(
          JSON.stringify(
            command('password-reset.v1', { displayName: 'Alice' }),
          ),
        ),
      ),
    ).toThrow('invalid email command payload');

    const json = Buffer.from(JSON.stringify(command()));
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), json]);
    expect(() => parseEmailCommand(withBom)).toThrow();
  });

  it('renders escaped text and HTML for both allowlisted templates', () => {
    const participant = parseEmailCommand(
      Buffer.from(JSON.stringify(command())),
    );
    const participantMessage = renderEmailMessage(participant);
    expect(participantMessage.subject).toBe('Your MyOTA account is ready');
    expect(participantMessage.html).toContain('&lt;Alice &amp; Bob&gt;');
    expect(participantMessage.html).not.toContain('<Alice & Bob>');

    const administrator = parseEmailCommand(
      Buffer.from(
        JSON.stringify(
          command('account-created-administrator.v1', {
            createdAccountName: '<New Admin>',
            createdAccountRole: 'ADMINISTRATOR',
          }),
        ),
      ),
    );
    expect(renderEmailMessage(administrator)).toEqual({
      subject: 'A MyOTA account was created',
      text: 'Hello,\n\nA administrator account for <New Admin> was created.\n',
      html: '<p>Hello,</p><p>A administrator account for &lt;New Admin&gt; was created.</p>',
    });
  });

  it('persists delivery before acknowledging the JetStream message', async () => {
    const events: string[] = [];
    const worker = createWorker(events);

    await worker.handle(deliveryMessage(events));

    expect(events).toEqual(['claim', 'identity', 'smtp', 'delivered', 'ack']);
  });

  it('acks completed work without resolving a recipient or sending again', async () => {
    const events: string[] = [];
    const worker = createWorker(events, { claimState: 'DELIVERED' });

    await worker.handle(deliveryMessage(events, 2));

    expect(events).toEqual(['claim', 'ack']);
  });

  it('persists a retry before delayed NAK and keeps SMTP errors redacted', async () => {
    const events: string[] = [];
    const worker = createWorker(events, {
      smtpError: new Error('smtp password must not be logged'),
      retryAttempts: 2,
    });

    await worker.handle(deliveryMessage(events, 2));

    expect(events.slice(0, 5)).toEqual([
      'claim',
      'identity',
      'smtp',
      'retry',
      'nak:2000',
    ]);
    expect(events.join('\n')).not.toContain('smtp password must not be logged');
  });

  it('persists retry exhaustion as a dead letter before terminating', async () => {
    const events: string[] = [];
    const worker = createWorker(events, {
      smtpError: new Error('connection refused'),
    });

    await worker.handle(deliveryMessage(events, 8));

    expect(events).toContain('dead-letter:delivery_exhausted');
    expect(events.at(-2)).toBe('term');
    expect(events.at(-1)).toBe(
      'error:Email delivery exhausted its retry limit',
    );
    expect(events).not.toContain('retry');
  });
});
