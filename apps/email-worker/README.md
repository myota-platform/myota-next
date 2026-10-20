# Email delivery worker

The NestJS worker consumes the registered `email.send.v1` command from
`MYOTA_EMAIL_WORK` using the `email-delivery-v1` durable. It validates the
versioned command, resolves the current recipient through the protected Identity
API, renders only the two contract-approved templates, and sends using SMTP
STARTTLS or implicit TLS. It does not expose an inbound send API.

Delivery state, attempts, and redacted dead letters are stored in the Core
database. Apply `npm run migrate:db -- --owner=core` before starting the worker.
The worker acknowledges only after the delivery result has been committed. A
crash after SMTP accepts a message but before that commit can cause a duplicate;
delivery is at least once.

Required configuration includes `CORE_DATABASE_URL`, `NATS_URL`,
`MYOTA_IDENTITY_URL` (or the legacy `IDENTITY_INTERNAL_URL` alias),
`MYOTA_EMAIL_SERVICE_CLIENT_SECRET`,
`EMAIL_SENDER_ADDRESS`, `EMAIL_SENDER_DISPLAY_NAME`, `EMAIL_SMTP_HOST`,
`EMAIL_SMTP_PORT`, `EMAIL_SMTP_USERNAME`, `EMAIL_SMTP_PASSWORD`,
`EMAIL_SMTP_TLS_MODE`, and `EMAIL_SMTP_TIMEOUT_SECONDS`. Secrets can be mounted
as files by setting the corresponding `_FILE` environment variable instead of
the value variable. SMTP TLS, timeouts, credentials, and sender values are
validated before the worker starts.
When both Identity URL variables are set, `MYOTA_IDENTITY_URL` takes precedence.

To request an audited recovery, reset one dead-letter ledger entry and record
the operator reason with:

```sh
npm run redrive:email -- --work-id UUID --error-code delivery_exhausted --actor operator --reason "approved recovery"
```

After the transaction succeeds, replay the original work command through its
producer outbox using the same work ID. The worker does not retain commands,
recipient addresses, or message content. `/healthz`, `/readyz`, and Prometheus
metrics are exposed on `EMAIL_HEALTH_PORT` (default `9108`). Identity
production and deployment qualification remain separate steps.

Set `MYOTA_OTEL_ENABLED=1` to enable OTLP export. The worker exports
`email.delivery` spans with incoming W3C `traceparent`/`tracestate` context,
bounded delivery outcome and duration metrics, and privacy-safe delivery logs.
The default gRPC endpoint is `http://otel-collector:4317`; override it with
`OTEL_EXPORTER_OTLP_ENDPOINT`. Metric export runs every 15 seconds by default;
`MYOTA_OTEL_METRIC_INTERVAL_MS` changes that interval. Exporter setup failures
leave the worker running with its Prometheus metrics and health endpoints.
