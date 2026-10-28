# Observe delivery smoke test

This guide records both the local `@nestjs/observe` smoke test and the
deployment check against an isolated receiver in `myota-test`. The isolated
receiver verifies deployment delivery without contacting a hosted Observe
account.

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
receives nothing. A third case runs a Nest custom event transport, dispatches a
worker operation with an `X-Request-ID`, and checks that its Observe snapshot,
forwarded log, and bounded custom outcome metric reach the local collector.

The test uses the real `@nestjs/observe` worker and wire format. Its credentials
are inert test values; they are sent only to the loopback server and are not
deployment credentials.

## Deployment evidence — 2026-10-28

The Rancher-managed `myota-test` release is deployed at Helm revision 67,
chart `1.1.6-testing.0b6eb64235ba.1`. All 17 Deployments and 22 requested
replicas are Ready, and Prometheus reports all 17 discovered targets up. The
four Activity and Geodata worker dependency gauges report NATS and PostgreSQL
healthy; no `myota-test` alerts were firing during the check. No alerts firing
is an observation, not proof that alert rules have been triggered end to end.

Using test-only Admin and Participant accounts, successful `POST
/v1/identity/auth/login` and `GET /v1/identity/me` requests returned HTTP 200.
Their request IDs appeared as both trace IDs and forwarded log trace IDs at
the `gateway` and `identity-api` services. Prometheus recorded the matching
HTTP 200 route counters. The temporary in-cluster receiver therefore verifies
authenticated, cross-service API trace and log delivery from the deployed
applications. Example request IDs: Admin login
`37faccef-9a04-433f-9ba7-568e86898648` and `/me`
`facc1fed-0a59-4b17-a91f-1225fafd87e4`; Participant login
`96c1d0c8-9fe9-4076-9646-c6d229074e81` and `/me`
`dee9f6c6-c545-415e-a7fe-46835a981c4e`.

All deployed NestJS workers sent periodic Observe batches during the sample,
but their batches contained no task snapshots or forwarded logs. This proves
collector delivery and configured service IDs for idle workers, not telemetry
correlation for a worker business operation. Worker-operation correlation,
behavioral alert qualification, and delivery to a hosted Observe account remain
open under [issue #90](https://github.com/myota-platform/myota-next/issues/90)
and [issue #91](https://github.com/myota-platform/myota-next/issues/91).

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

## Isolated test receiver

The `myota-test` namespace now has a temporary, in-cluster HTTP receiver for
qualification. The Helm test values configure the Observe SDK to send to
`http://myota-test-observe-mock.myota-test.svc.cluster.local:8080` and read
test-only credentials from Secret `myota-observe-mock` (`app-key` and
`app-secret`). The collector and Secret are local qualification resources;
their manifests and inert test credentials stay under the ignored
`runtime-secrets/` directory and are not committed.

This setup exercises the real `@nestjs/observe` instrumentation and HTTP
delivery path without sending telemetry to a hosted Observe account. It does
not qualify hosted Observe dashboards or alerting. Use chart values to configure
workload environment; do not patch Helm-managed Deployment fields directly, or
Helm may reject a later upgrade due to conflicting field ownership. The
authenticated API delivery check above is complete for Gateway and Identity;
worker task correlation and hosted Observe qualification remain open.
