import { createTransport } from 'nodemailer';

export type SmtpConfig = {
  host: string;
  port: number;
  username: string;
  password: string;
  tlsMode: 'starttls' | 'implicit';
  timeoutMs: number;
};

export function createEmailSmtpTransport(config: SmtpConfig) {
  return createTransport({
    host: config.host,
    port: config.port,
    secure: config.tlsMode === 'implicit',
    requireTLS: config.tlsMode === 'starttls',
    auth: { user: config.username, pass: config.password },
    connectionTimeout: config.timeoutMs,
    greetingTimeout: config.timeoutMs,
    socketTimeout: config.timeoutMs,
  });
}
