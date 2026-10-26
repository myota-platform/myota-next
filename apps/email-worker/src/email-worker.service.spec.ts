import { createServer } from 'node:net';
import type { JsMsg } from '@nats-io/jetstream';
import { afterEach, vi } from 'vitest';
import { EmailWorkerService } from './email-worker.service.js';
import { createEmailSmtpTransport } from './email-smtp.js';
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
    payload: {
      requestId: workId,
      recipientAccountId,
      templateId,
      templateData,
    },
  };
}

type WorkerHarness = {
  handle(message: JsMsg): Promise<void>;
  claim(parsed: EmailCommand): Promise<string>;
  resolveRecipient(accountId: string): Promise<string>;
  markDelivered(id: string): Promise<void>;
  retry(id: string): Promise<number>;
  deadLetter(id: string | null, code: string): Promise<void>;
  identityToken: string;
  identityTokenExpiresAt: number;
  identityClientSecret: string;
  identityUrl: string;
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
  sentMessages: unknown[];
  sender: { address: string; displayName: string };
  logger: { warn(message: string): void; error(message: string): void };
};

function createWorker(
  events: string[],
  options: {
    claimState?: string;
    smtpError?: Error;
    retryAttempts?: number;
    useActualResolver?: boolean;
    identityToken?: string;
  } = {},
) {
  const sentMessages: unknown[] = [];
  const worker = Object.assign(
    Object.create(EmailWorkerService.prototype) as WorkerHarness,
    {
      claim: async (_parsed: EmailCommand) => {
        events.push('claim');
        return options.claimState ?? 'CLAIMED';
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
        sendMail: async (message: unknown) => {
          sentMessages.push(message);
          events.push('smtp');
          if (options.smtpError) throw options.smtpError;
        },
      },
      sender: { address: 'noreply@example.test', displayName: 'MyOTA' },
      identityToken: options.identityToken ?? 'cached-token',
      identityTokenExpiresAt: Date.now() + 60_000,
      identityClientSecret: 'email-service-secret-for-tests',
      identityUrl: 'https://identity.example.test',
      sentMessages,
      logger: {
        warn: (message: string) => events.push(`warn:${message}`),
        error: (message: string) => events.push(`error:${message}`),
      },
    },
  );
  if (!options.useActualResolver) {
    worker.resolveRecipient = async (_accountId: string) => {
      events.push('identity');
      return 'alice@example.test';
    };
  }
  return worker;
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

function stubValidEmailEnvironment(overrides: Record<string, string> = {}) {
  const values = {
    EMAIL_SMTP_HOST: 'smtp.example.test',
    EMAIL_SMTP_PORT: '587',
    EMAIL_SMTP_USERNAME: 'myota',
    EMAIL_SMTP_PASSWORD: 'smtp-test-password',
    EMAIL_SMTP_PASSWORD_FILE: '',
    EMAIL_SENDER_ADDRESS: 'noreply@example.test',
    EMAIL_SENDER_DISPLAY_NAME: 'MyOTA',
    MYOTA_EMAIL_SERVICE_CLIENT_SECRET: 'x'.repeat(32),
    MYOTA_EMAIL_SERVICE_CLIENT_SECRET_FILE: '',
    ...overrides,
  };
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('email worker Python compatibility', () => {
  it('parses allowlisted participant, administrator, and verification commands', () => {
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
    const verification = parseEmailCommand(
      Buffer.from(
        JSON.stringify(
          command('participant-email-verification.v1', {
            displayName: 'New Participant',
            verificationUrl:
              'https://participant.example.test/verify-email?token=abc',
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
    expect(verification.templateId).toBe('participant-email-verification.v1');
    expect(renderEmailMessage(verification).html).toContain(
      'href="https://participant.example.test/verify-email?token=abc"',
    );
  });

  it('rejects mismatched email work IDs and unsafe verification URLs', () => {
    const invalidId = command('participant-email-verification.v1', {
      displayName: 'New Participant',
      verificationUrl:
        'https://participant.example.test/verify-email?token=abc',
    });
    invalidId.payload.requestId = recipientAccountId;
    expect(() =>
      parseEmailCommand(Buffer.from(JSON.stringify(invalidId))),
    ).toThrow('invalid email command payload');
    const invalidUrl = command('participant-email-verification.v1', {
      displayName: 'New Participant',
      verificationUrl: 'javascript:alert(1)',
    });
    expect(() =>
      parseEmailCommand(Buffer.from(JSON.stringify(invalidUrl))),
    ).toThrow('invalid participant verification email data');
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

  it('delivers the participant email verification link through the SMTP transport', async () => {
    const events: string[] = [];
    const worker = createWorker(events);
    const verificationCommand = command('participant-email-verification.v1', {
      displayName: 'Casey Participant',
      verificationUrl:
        'https://participant.example.test/verify-email?token=opaque-test-token',
    });
    const message = {
      ...deliveryMessage(events),
      data: Buffer.from(JSON.stringify(verificationCommand)),
    } as JsMsg;

    await worker.handle(message);

    expect(worker.sentMessages).toHaveLength(1);
    expect(worker.sentMessages[0]).toMatchObject({
      to: 'alice@example.test',
      subject: 'Verify your MyOTA email address',
      text: expect.stringContaining(
        'https://participant.example.test/verify-email?token=opaque-test-token',
      ),
      html: expect.stringContaining('Verify email address'),
    });
    expect(events.at(-1)).toBe('ack');
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

  it('caches an Identity service token while resolving current addresses', async () => {
    const worker = createWorker([], {
      useActualResolver: true,
      identityToken: '',
    });
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ accessToken: 'identity-token', expiresIn: 300 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ deliverableAddress: 'alice@example.test' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ deliverableAddress: 'alice@example.test' }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(worker.resolveRecipient(recipientAccountId)).resolves.toBe(
      'alice@example.test',
    );
    await expect(worker.resolveRecipient(recipientAccountId)).resolves.toBe(
      'alice@example.test',
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://identity.example.test/v1/identity/auth/service-token',
    );
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      service: 'email-service',
      clientSecret: 'email-service-secret-for-tests',
    });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({
      authorization: 'Bearer identity-token',
    });
  });

  it('dead-letters unavailable recipients before terminating delivery', async () => {
    const events: string[] = [];
    const worker = createWorker(events, { useActualResolver: true });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404 }),
    );

    await worker.handle(deliveryMessage(events));

    expect(events).toEqual([
      'claim',
      'dead-letter:recipient_unavailable',
      'term',
      'warn:Email recipient is unavailable',
    ]);
  });

  it('retries temporary Identity failures without exposing response details', async () => {
    const events: string[] = [];
    const worker = createWorker(events, {
      useActualResolver: true,
      identityToken: '',
      retryAttempts: 1,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('identity response secret')),
    );

    await worker.handle(deliveryMessage(events));

    expect(events.slice(0, 3)).toEqual(['claim', 'retry', 'nak:1000']);
    expect(events.join('\n')).not.toContain('identity response secret');
  });

  it.each([
    ['EMAIL_SMTP_PASSWORD', ''],
    ['EMAIL_SMTP_TLS_MODE', 'none'],
    ['EMAIL_SMTP_TIMEOUT_SECONDS', '31'],
  ])('rejects unsafe SMTP configuration: %s', (name, value) => {
    stubValidEmailEnvironment({ [name]: value });

    expect(() => new EmailWorkerService(null)).toThrow(
      'SMTP configuration is incomplete or outside bounds',
    );
  });

  it('accepts the reference STARTTLS SMTP configuration', () => {
    stubValidEmailEnvironment();

    expect(() => new EmailWorkerService(null)).not.toThrow();
  });

  it('starts STARTTLS before authentication and fails closed if TLS fails', async () => {
    const commands: string[] = [];
    const server = createServer((socket) => {
      let buffered = '';
      let upgradingToTls = false;
      socket.write('220 smtp.example.test ESMTP\r\n');
      socket.on('data', (chunk) => {
        if (upgradingToTls) {
          commands.push('TLS_HANDSHAKE');
          socket.destroy();
          return;
        }
        buffered += chunk.toString('ascii');
        while (buffered.includes('\r\n')) {
          const end = buffered.indexOf('\r\n');
          const command = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          commands.push(command.split(' ', 1)[0]!.toUpperCase());
          if (command.startsWith('EHLO') || command.startsWith('HELO')) {
            socket.write(
              '250-smtp.example.test\r\n250-STARTTLS\r\n250 AUTH PLAIN LOGIN\r\n',
            );
          } else if (command.toUpperCase() === 'STARTTLS') {
            upgradingToTls = true;
            socket.write('220 Ready to start TLS\r\n');
          } else if (command.toUpperCase() === 'QUIT') {
            socket.end('221 Bye\r\n');
          } else {
            socket.write('250 OK\r\n');
          }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('SMTP test server did not bind a TCP port');
    const transport = createEmailSmtpTransport({
      host: '127.0.0.1',
      port: address.port,
      username: 'myota',
      password: 'smtp-test-password',
      tlsMode: 'starttls',
      timeoutMs: 2000,
    });

    try {
      await expect(
        transport.sendMail({
          from: 'noreply@example.test',
          to: 'alice@example.test',
          subject: 'test',
          text: 'test',
        }),
      ).rejects.toThrow();
      expect(commands).toContain('EHLO');
      expect(commands).toContain('STARTTLS');
      expect(commands).toContain('TLS_HANDSHAKE');
      expect(commands.indexOf('STARTTLS')).toBeLessThan(
        commands.indexOf('TLS_HANDSHAKE'),
      );
      expect(commands.some((command) => command.startsWith('AUTH'))).toBe(
        false,
      );
    } finally {
      transport.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
