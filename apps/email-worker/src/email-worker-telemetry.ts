import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  metrics,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  trace,
} from '@opentelemetry/api';
import type { Counter, Histogram, Span, Tracer } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import type { Logger as OtelLogger } from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  LoggerProvider,
  BatchLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

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
  private spanTracer?: Tracer;
  private otelLogger?: OtelLogger;
  private otelAttempts?: Counter;
  private otelDuration?: Histogram;
  private otelSmtpDuration?: Histogram;
  private traceProvider?: BasicTracerProvider;
  private meterProvider?: MeterProvider;
  private loggerProvider?: LoggerProvider;

  async start() {
    const enabled = (process.env.MYOTA_OTEL_ENABLED ?? '0')
      .trim()
      .toLowerCase();
    if (['', '0', 'false', 'no', 'off'].includes(enabled)) return;

    try {
      const endpoint =
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://otel-collector:4317';
      const resource = resourceFromAttributes({
        'service.name': process.env.OTEL_SERVICE_NAME ?? 'myota-email-service',
        'service.namespace': 'myota',
        'deployment.environment': process.env.MYOTA_ENV ?? 'development',
        'service.instance.id': process.env.HOSTNAME ?? 'local',
      });

      this.traceProvider = new BasicTracerProvider({
        resource,
        spanProcessors: [
          new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint })),
        ],
      });
      trace.setGlobalTracerProvider(this.traceProvider);
      propagation.setGlobalPropagator(new W3CTraceContextPropagator());
      this.spanTracer = trace.getTracer('myota.email');

      const metricInterval = boundedInt(
        process.env.MYOTA_OTEL_METRIC_INTERVAL_MS,
        15_000,
        1_000,
        3_600_000,
      );
      const metricReader = new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: endpoint }),
        exportIntervalMillis: metricInterval,
      });
      this.meterProvider = new MeterProvider({
        resource,
        readers: [metricReader],
      });
      metrics.setGlobalMeterProvider(this.meterProvider);
      const meter = this.meterProvider.getMeter('myota.email');
      this.otelAttempts = meter.createCounter('myota.email.delivery.attempts', {
        unit: '{attempt}',
        description: 'Email delivery outcomes recorded by the worker',
      });
      this.otelDuration = meter.createHistogram(
        'myota.email.delivery.duration',
        {
          unit: 's',
          description: 'Time spent resolving and delivering one message',
        },
      );
      this.otelSmtpDuration = meter.createHistogram(
        'myota.email.smtp.delivery.duration',
        {
          unit: 's',
          description: 'Time spent in one SMTP delivery operation',
        },
      );

      this.loggerProvider = new LoggerProvider({
        resource,
        processors: [
          new BatchLogRecordProcessor({
            exporter: new OTLPLogExporter({ url: endpoint }),
          }),
        ],
      });
      logs.setGlobalLoggerProvider(this.loggerProvider);
      this.otelLogger = this.loggerProvider.getLogger('myota.email');
    } catch {
      this.spanTracer = undefined;
      this.otelLogger = undefined;
      this.otelAttempts = undefined;
      this.otelDuration = undefined;
      this.otelSmtpDuration = undefined;
      await this.shutdownOpenTelemetry();
      process.stderr.write(
        'OpenTelemetry setup failed; continuing with Prometheus metrics\n',
      );
    }
  }

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
    this.otelAttempts?.add(1, {
      'email.outcome': outcome,
      'email.template_id': template,
    });
  }

  observeDuration(templateId: string, seconds: number) {
    this.observe(this.durations, templateId, seconds);
    this.otelDuration?.record(Math.max(0, seconds), {
      'email.template_id': labelTemplate(templateId),
    });
  }

  observeSmtpDuration(templateId: string, seconds: number) {
    this.observe(this.smtpDurations, templateId, seconds);
    this.otelSmtpDuration?.record(Math.max(0, seconds));
  }

  startDeliverySpan(
    templateId: string,
    carrier: Record<string, string>,
  ): Span | undefined {
    if (!this.spanTracer) return undefined;
    const parent = propagation.extract(ROOT_CONTEXT, carrier);
    return this.spanTracer.startSpan(
      'email.delivery',
      {
        kind: SpanKind.INTERNAL,
        attributes: { 'email.template_id': labelTemplate(templateId) },
      },
      parent,
    );
  }

  recordLog(
    severity: 'WARN' | 'ERROR',
    message: string,
    attributes: Record<string, string> = {},
  ) {
    this.otelLogger?.emit({
      severityNumber:
        severity === 'ERROR' ? SeverityNumber.ERROR : SeverityNumber.WARN,
      severityText: severity,
      body: message,
      attributes,
    });
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
    await this.shutdownOpenTelemetry();
  }

  private async shutdownOpenTelemetry() {
    const providers = [
      this.traceProvider?.shutdown(),
      this.meterProvider?.shutdown(),
      this.loggerProvider?.shutdown(),
    ].filter((value): value is Promise<void> => value !== undefined);
    this.traceProvider = undefined;
    this.meterProvider = undefined;
    this.loggerProvider = undefined;
    await Promise.allSettled(providers);
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
