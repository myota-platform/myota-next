# Observe delivery smoke test

This check qualifies the local `@nestjs/observe` integration. It does not
qualify delivery to a real Observe account or the deployed `myota-test`
environment.

## Run the smoke test

From the repository root, run:

```sh
npm exec vitest -- run libs/platform/src/observe.integration.spec.ts
```

The first case starts a Nest HTTP application and an ephemeral loopback
collector. It uses test-only credentials and verifies gzip delivery to
`/applications/telemetry`, the configured service ID and build version, and
an HTTP request snapshot plus a forwarded stdout log in the same batch. The
trace ID on the log must match the request snapshot. The second case starts
and serves a request with credentials absent, then verifies the collector
receives nothing.

The test uses the real `@nestjs/observe` worker and wire format. Its credentials
are inert test values; they are sent only to the loopback server and are not
deployment credentials.

## Current deployment gate

On 2026-10-27, the `myota-test` Helm values had `observe.enabled: false`, no
endpoint override, and no `myota-observe` Secret. The smoke test therefore
proves instrumentation and the configured delivery path can work, but it does
not prove authenticated delivery from deployed APIs/workers, dashboard
visibility, alerting, or cross-service workflow correlation. Provision
approved test credentials through the secret store and complete the deployed
checks tracked by [issue #90](https://github.com/myota-platform/myota-next/issues/90)
and [issue #91](https://github.com/myota-platform/myota-next/issues/91).

A live recheck at 18:57 UTC found all 21 requested `myota-test` replicas ready,
all 17 discovered Prometheus targets `up=1`, and all four Activity/Geodata NATS
and PostgreSQL dependency gauges healthy; no namespace alerts were firing. The
cluster still had no Observe Secret, Observe workload environment, Loki, Tempo,
or OpenTelemetry Collector. This verifies metrics scraping and worker dependency
availability only; it does not provide Observe delivery or deployed log/trace
correlation.

A further live recheck at 23:23 UTC on 2026-10-27 found all 16 Helm-managed
Deployments available (21/21 requested replicas) and all 17 `myota-test`
Prometheus targets up. Helm now has `observe.enabled: true`, but the configured
`myota-observe` Secret is absent and its app-key/app-secret references are
optional. The service bootstrap enables reporting only when both credentials
are non-empty, so the current deployment is expected to keep reporting disabled;
this follows from the rendered configuration and bootstrap predicate, not a
direct read of environment values inside the distroless containers. The Helm
endpoint override is empty, no Loki/Tempo/OpenTelemetry Collector Deployment was
found, and authenticated delivery to a real Observe account remains unqualified.

## Authenticated Grafana dashboard proxy

Issue [#116](https://github.com/myota-platform/myota-next/issues/116) records the
deployed Admin-browser qualification for the Grafana proxy at `/observability/`.
A signed-in Admin opened the default dashboard with six panels; 13 dashboard,
search, and query API responses and 49 CSS, JavaScript, and image assets returned
HTTP 200. Grafana's health endpoint reported database status `ok`, and the
dashboard catalogue returned 52 dashboards. The shared Grafana Service remains
ClusterIP-only.

Unauthenticated access and access by a signed-in Participant without
`observability.view` redirected to the Admin login (HTTP 302). That is the
expected authorization boundary; a direct unauthenticated request to the
subpath should not be used as a dashboard availability check. Grafana
user/profile and star APIs returned HTTP 401 under the existing anonymous
dashboard mode, while dashboard viewing and query APIs succeeded. The dashboard
proxy is qualified for authorized viewing, but this does not qualify Observe
collector delivery or cross-service log/trace correlation; those remain open
under [#90](https://github.com/myota-platform/myota-next/issues/90) and
[#91](https://github.com/myota-platform/myota-next/issues/91).
