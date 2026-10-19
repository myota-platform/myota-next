import { createServer } from 'node:http';
import type { Server } from 'node:http';

const OUTCOMES = [
  'delivered',
  'duplicate',
  'dead_letter',
  'invalid_command',
  'smtp_failure',
  'identity_failure',
  'delivery_failure',
] as const;
const TEMPLATES = [
  'account-created-participant.v1',
  'account-created-administrator.v1',
  'unknown',
] as const;
const BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

type Outcome = (typeof OUTCOMES)[number];
type Template = (typeof TEMPLATES)[number];

export class EmailWorkerTelemetry {
  private readonly outcomes = new Map<string, number>();
  private readonly durations = new Map<
    Template,
    { count: number; sum: number; buckets: number[] }
  >();
  private readonly smtpDurations = new Map<
    Template,
    { count: number; sum: number; buckets: number[] }
  >();
  private server?: Server;
  private ready = false;
  private smtpAvailable = 0;
  private pending = 0;
  private ackPending = 0;
  private oldestAge = 0;
  private readonly maxMessages = boundedInt(
    process.env.EMAIL_QUEUE_MAX_MESSAGES,
    0,
    0,
    10_000_000,
  );

  async listen() {
    if (this.server) return;
    this.server = createServer((request, response) => {
      if (request.url === '/healthz') {
        response.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n');
        return;
      }
      if (request.url === '/readyz') {
        response
          .writeHead(this.ready ? 200 : 503, {
            'content-type': 'text/plain',
          })
          .end(this.ready ? 'ready\n' : 'not ready\n');
        return;
      }
      if (request.url === '/metrics') {
        response
          .writeHead(200, {
            'content-type': 'text/plain; version=0.0.4; charset=utf-8',
          })
          .end(this.renderMetrics());
        return;
      }
      response.writeHead(404).end();
    });
    const port = boundedInt(process.env.EMAIL_HEALTH_PORT, 9108, 1, 65535);
    const host = process.env.EMAIL_HEALTH_HOST ?? '0.0.0.0';
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject).listen(port, host, resolve);
    });
  }

  setReady(ready: boolean) {
    this.ready = ready;
  }

  record(outcome: Outcome, templateId: string) {
    const template = labelTemplate(templateId);
    const key = `${outcome}\u0000${template}`;
    this.outcomes.set(key, (this.outcomes.get(key) ?? 0) + 1);
  }

  observeDuration(templateId: string, seconds: number) {
    this.observe(this.durations, templateId, seconds);
  }

  observeSmtpDuration(templateId: string, seconds: number) {
    this.observe(this.smtpDurations, templateId, seconds);
  }

  private observe(
    metrics: Map<Template, { count: number; sum: number; buckets: number[] }>,
    templateId: string,
    seconds: number,
  ) {
    const template = labelTemplate(templateId);
    const value = metrics.get(template) ?? {
      count: 0,
      sum: 0,
      buckets: BUCKETS.map(() => 0),
    };
    value.count++;
    value.sum += seconds;
    BUCKETS.forEach((bound, index) => {
      if (seconds <= bound) value.buckets[index]++;
    });
    metrics.set(template, value);
  }

  smtpResult(available: boolean) {
    this.smtpAvailable = available ? 1 : 0;
  }

  updateQueue(pending: number, ackPending: number, oldestAge = 0) {
    this.pending = Math.max(0, Number(pending) || 0);
    this.ackPending = Math.max(0, Number(ackPending) || 0);
    this.oldestAge = Math.max(0, Number(oldestAge) || 0);
  }

  async close() {
    this.ready = false;
    if (this.server)
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private renderMetrics() {
    const lines = [
      '# HELP myota_email_delivery_attempts_total Email work outcomes recorded by the consumer.',
      '# TYPE myota_email_delivery_attempts_total counter',
    ];
    for (const outcome of OUTCOMES) {
      for (const template of TEMPLATES) {
        const count = this.outcomes.get(`${outcome}\u0000${template}`) ?? 0;
        lines.push(
          `myota_email_delivery_attempts_total{outcome="${outcome}",template="${template}"} ${count}`,
        );
      }
    }
    lines.push(
      '# HELP myota_email_delivery_duration_seconds Time spent resolving and delivering an email command.',
      '# TYPE myota_email_delivery_duration_seconds histogram',
    );
    for (const template of TEMPLATES) {
      const value = this.durations.get(template) ?? {
        count: 0,
        sum: 0,
        buckets: BUCKETS.map(() => 0),
      };
      BUCKETS.forEach((bound, index) => {
        lines.push(
          `myota_email_delivery_duration_seconds_bucket{template="${template}",le="${bound}"} ${value.buckets[index]}`,
        );
      });
      lines.push(
        `myota_email_delivery_duration_seconds_bucket{template="${template}",le="+Inf"} ${value.count}`,
        `myota_email_delivery_duration_seconds_sum{template="${template}"} ${value.sum}`,
        `myota_email_delivery_duration_seconds_count{template="${template}"} ${value.count}`,
      );
    }
    lines.push(
      '# HELP myota_email_smtp_delivery_duration_seconds Time spent delivering one email over SMTP.',
      '# TYPE myota_email_smtp_delivery_duration_seconds histogram',
    );
    for (const template of TEMPLATES) {
      const value = this.smtpDurations.get(template) ?? {
        count: 0,
        sum: 0,
        buckets: BUCKETS.map(() => 0),
      };
      BUCKETS.forEach((bound, index) => {
        lines.push(
          `myota_email_smtp_delivery_duration_seconds_bucket{template="${template}",le="${bound}"} ${value.buckets[index]}`,
        );
      });
      lines.push(
        `myota_email_smtp_delivery_duration_seconds_bucket{template="${template}",le="+Inf"} ${value.count}`,
        `myota_email_smtp_delivery_duration_seconds_sum{template="${template}"} ${value.sum}`,
        `myota_email_smtp_delivery_duration_seconds_count{template="${template}"} ${value.count}`,
      );
    }
    lines.push(
      '# TYPE myota_email_smtp_last_delivery_available gauge',
      `myota_email_smtp_last_delivery_available ${this.smtpAvailable}`,
      '# TYPE myota_email_queue_pending_messages gauge',
      `myota_email_queue_pending_messages ${this.pending}`,
      '# TYPE myota_email_queue_ack_pending_messages gauge',
      `myota_email_queue_ack_pending_messages ${this.ackPending}`,
      '# TYPE myota_email_queue_oldest_message_age_seconds gauge',
      `myota_email_queue_oldest_message_age_seconds ${this.oldestAge}`,
      '# TYPE myota_email_queue_max_messages gauge',
      `myota_email_queue_max_messages ${this.maxMessages}`,
    );
    return `${lines.join('\n')}\n`;
  }
}

function labelTemplate(template: string): Template {
  return TEMPLATES.includes(template as Template)
    ? (template as Template)
    : 'unknown';
}

function boundedInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}
