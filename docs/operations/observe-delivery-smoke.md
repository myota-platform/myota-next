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

### Earlier check — revision 67

The Rancher-managed `myota-test` release was deployed at Helm revision 67,
chart `1.1.6-testing.0b6eb64235ba.1`. All 17 Deployments and 22 requested
replicas were Ready, and Prometheus reported all 17 discovered targets up.
The four Activity and Geodata worker dependency gauges reported NATS and
PostgreSQL healthy. No `myota-test` alerts were firing during that check; this
does not prove alert rules have been triggered end to end.

Using test-only Admin and Participant accounts, successful
`POST /v1/identity/auth/login` and `GET /v1/identity/me` requests returned
HTTP 200. Their request IDs appeared as both trace IDs and forwarded log trace
IDs at `gateway` and `identity-api`. Prometheus recorded the matching HTTP 200
route counters. Example request IDs:

- Admin login: `37faccef-9a04-433f-9ba7-568e86898648`; `/me`:
  `facc1fed-0a59-4b17-a91f-1225fafd87e4`.
- Participant login: `96c1d0c8-9fe9-4076-9646-c6d229074e81`; `/me`:
  `dee9f6c6-c545-415e-a7fe-46835a981c4e`.

### Worker correlation check — revision 70

After PRs [#221](https://github.com/myota-platform/myota-next/pull/221) and
[#224](https://github.com/myota-platform/myota-next/pull/224), the release
deployed chart `myota-next-1.1.6-testing.cb48c2a0fe92.1` at Helm revision 70.
All 17 Deployments were Ready. A test Participant login and subsequent
`/v1/identity/me` request both returned HTTP 200 with request ID
`0d9bda80-602c-43a2-ae73-3026c1b2cbff`.

The in-cluster receiver recorded that same ID as a trace ID and forwarded log
trace ID for both `gateway` and `identity-api`. The `activity-notifications`
worker also delivered an Observe batch containing a snapshot with that ID,
confirming correlation from the login request through its asynchronous event
handler. Its batch had no forwarded log or operation name. The bounded
`myota_activity_notification_outcomes_total{outcome="processed"}` counter
increased from 2 to 3 during this check. The event-processing trace is verified;
worker log coverage and behavioral alert qualification remain open under
[#90](https://github.com/myota-platform/myota-next/issues/90) and
[#91](https://github.com/myota-platform/myota-next/issues/91). Delivery to a
hosted Observe account also remains unqualified.

### Worker log and alert check — revision 72

Protected rollout [#228](https://github.com/myota-platform/myota-next/pull/228)
deployed chart `myota-next-1.1.6-testing.b6a158aeadad.1` at Helm revision 72.
All 17 Deployments (22/22 replicas) and all 17 Prometheus scrape targets were
ready. A login attempt for a synthetic, non-existent `.invalid` address
returned HTTP 400 with request ID
`e5885f8b-787b-4d2c-b3f1-044b94f34c2d`; it created no account.

The Observe mock receiver recorded that ID as both snapshot trace ID and
forwarded log trace ID for `gateway`, `identity-api`, and
`activity-notifications`. The Activity Notifications pod log included a
structured `activity_notification.settled` record for
`identity.login.failed.v1`, outcome `processed`, and delivery count 1. Its
Observe batch contained one log and one trace snapshot with the same ID. The
worker's processed-outcome counter was 1 after the rollout.

All seven `myota.api` and `myota.delivery` Prometheus alert rules are loaded
with healthy evaluation status. Two
`MyOTAUnresolvedOutboxDeadLetters` alerts are firing for Core and Geodata and
carry `service_id=outbox-worker`. The Alertmanager has no notification
receiver, so this verifies rule discovery and firing state, not email or
webhook delivery. Hosted Observe delivery remains unqualified.

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
collector delivery or cross-service log/trace correlation by itself; those are
qualified separately above and tracked under
[#90](https://github.com/myota-platform/myota-next/issues/90) and
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
authenticated API and login-event correlation checks above cover Gateway,
Identity, and Activity Notifications. Worker logs for that event, other worker
operation types, hosted Observe delivery, and alert qualification remain open.

### Password-recovery request trace and token scan — revision 73

On 2026-10-28, a password-recovery request with a unique `X-Request-ID` returned
HTTP 200 from the deployed Identity API. The test receiver accepted an `identity-api`
batch containing that request ID and a recovery operation. The reset token was read
in memory from the Mailpit message; neither the exact token nor a `resetToken=` link
appeared in any `myota-test` pod log. The test receiver logs only the service ID, request ID, and operation name, so
raw OTLP attributes were not available for field-level inspection. The test recovery
rows and generated Mailpit message were invalidated or deleted afterward. This confirms
trace delivery and pod-log token exclusion, not token exclusion from every trace field
or hosted Observe delivery. See
[Participant password reset](https://github.com/myota-platform/myota-next/issues/114).
