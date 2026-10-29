# Observe delivery smoke test

This guide covers the local `@nestjs/observe` integration and deployed
qualification in `myota-test`. The isolated receiver verifies delivery and
correlation without sending telemetry to a hosted Observe account.

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

## Earlier deployment state — 2026-10-27

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

### In-cluster mock collector qualification

On 2026-10-28, a temporary, ClusterIP-only mock collector was used to check
delivery from the deployed NestJS services without sending test credentials to
an external Observe account. The fixture is
[`deploy/testing/observe-mock-collector.yaml`](../../deploy/testing/observe-mock-collector.yaml).
It accepts only gzip telemetry at `/applications/telemetry`, validates the
test-only app key and secret, and logs service IDs, trace IDs, operation names,
and record counts. It does not log credentials or telemetry payloads.

The mock also provides a credential-protected token scan for short, controlled
security checks. Register a random scan ID, a request ID, and the exact test
token with `POST /__test/token-scans`; the marker remains only in process
memory for at most two minutes. Read `GET /__test/token-scans/{id}` to obtain
only `requestObserved` and `tokenObserved` booleans, then remove it with
`DELETE /__test/token-scans/{id}`. The scanner checks raw accepted OTLP items
without retaining them or logging the marker. Do not put real participant
tokens in files, command history, CI output, or test logs. CI runs
`node tools/check-observe-mock-token-scanner.mjs`, which verifies that a
synthetic marker is detected without appearing in collector output.

The local test-only Secret manifest belongs at
`runtime-secrets/issue10-observe-mock.yaml`; `runtime-secrets/` is ignored by
Git. Use disposable credentials only. For the temporary test values, enable
Observe, keep `secretName: myota-observe`, and set the endpoint to
`http://myota-test-observe-mock.myota-test.svc.cluster.local:8080`. Send a
read-only request through the test Gateway and verify accepted batches from
both Gateway and a downstream service contain the same request trace ID. Then
remove the endpoint override, delete the test Secret, and remove the collector
resources. The regular endpoint is left empty so the SDK uses its configured
default when real Observe credentials are supplied.

The mock accepted telemetry batches from `gateway` and `activity-api` for the
same synthetic request trace ID
`0db1abd5-893c-4a80-b3d1-ff7ae6af7423`; the Prometheus Gateway request counter
also recorded the public HTTP 200. The batches contained no application logs
for that request. This establishes SDK-to-collector delivery and trace
propagation for one public read path, but not authenticated workflow behavior,
application-log correlation, hosted Observe ingestion, dashboards, or alerts.

After cleanup, chart revision 59 (`myota-next-1.1.6-testing.99f7023c115b.1`)
was `deployed`; all 15 chart-managed Deployments were ready (20/20 replicas),
none had `OBSERVE_ENDPOINT`, and the `myota-observe` Secret was absent. A fresh
public request returned HTTP 200 while the mock collector received no new
batches. The protected deployment workflow was canceled after Rancher had
completed and removed its operation record but before the workflow poller
observed completion; that specific run is not a passing gate. PR
[#209](https://github.com/myota-platform/myota-next/pull/209) changed the
poller to hand off a missing operation record to Rancher App
revision and Deployment digest/readiness checks. The next protected run
[#40613457838](https://github.com/myota-platform/myota-next/actions/runs/40613457838)
passed at Helm revision 60 (`myota-next-1.1.6-testing.637eaeea9b3c.1`), with
15 chart-managed Deployments ready (20/20 replicas). This qualifies the
rollout verification path; it does not qualify hosted Observe or authenticated
workflow signal coverage.
Issues [#10](https://github.com/myota-platform/myota-next/issues/10),
[#90](https://github.com/myota-platform/myota-next/issues/90), and
[#91](https://github.com/myota-platform/myota-next/issues/91) remain open for
the hosted Observe and authenticated workflow evidence.

### Prometheus scraping and alert coverage

A live check on 2026-10-28 at 01:31 UTC found all 17
`up{namespace="myota-test"}` targets at `1`. The `myota-test-apis` and
`myota-test-workers` ServiceMonitors scrape `/metrics` every 30 seconds. The
Gateway HTTP 200 request counter was queryable in Prometheus.

No active Prometheus alert had `namespace="myota-test"`. The cluster had 30
PrometheusRule resources, but none was in `myota-test` or labeled for that
release. This confirms target scraping, metric query visibility, and the
current absence of firing alerts for this namespace. It does not qualify
Alertmanager notification delivery or MyOTA-specific alert rules. Hosted
Observe receipt and authenticated workflow signal correlation remain open.

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

## Authenticated API delivery check — revision 68

After the earlier cleanup check, the `testing` branch reconfigured `myota-test`
to use a temporary, credential-protected in-cluster receiver. The test-only
Secret is stored outside Git. Protected rollout
[#40626824073](https://github.com/myota-platform/myota-next/actions/runs/40626824073)
deployed Helm revision 68, chart `1.1.6-testing.9db5f64189b1.1`, app version
`testing-0b6eb64`. All 17 Deployments and 22 requested replicas were Ready; the
Admin and Participant web hosts and API health endpoint returned HTTP 200. Admin
Web ran digest
`sha256:8501dd08285191109456e3fbfd0482c7d2b990387dc2f975667fbe292b196ffd`.

Fresh test Admin and Participant logins and authenticated `/me` calls returned
HTTP 200. Their request IDs matched both trace IDs and forwarded log IDs at
`gateway` and `identity-api`; Prometheus recorded the successful HTTP routes.
The four sample request IDs were Admin login
`e2e10439-f3c0-419e-80ca-43d27d7e4faa`, Admin `/me`
`8fe16e87-8b7c-41b5-be94-87e921b8d57a`, Participant login
`0b3c2947-0ef1-4798-8667-d1506213b5c0`, and Participant `/me`
`23c7893b-0331-4fca-bd25-19a870105dee`. Prometheus reported 17/17 targets up;
Activity and Geodata worker NATS/PostgreSQL dependency gauges were `1`. No
alerts with `namespace="myota-test"` were firing. This does not verify alert
notification delivery or a MyOTA-specific alert rule.

All deployed NestJS workers delivered periodic Observe batches under their
stable service IDs. The sampled idle-worker batches contained no task snapshots
or forwarded logs, so that sample did not qualify worker business-operation
telemetry. A separate synthetic password-recovery run delivered two reset emails to the
Mailpit sink, incremented the Email worker's `password-reset.v1` delivered
counter to `2`, and reported SMTP availability `1`; both messages were deleted
and the original test password was restored. Those worker metrics currently
provide no request-to-worker trace or log correlation. The revision 70 check
below verifies correlation for one asynchronous login event. Hosted Observe,
worker logs for that event, other worker operation types, and behavioral alerting
remain open under issues [#90](https://github.com/myota-platform/myota-next/issues/90)
and [#91](https://github.com/myota-platform/myota-next/issues/91). The local
recovery helper also received HTTP 403 for revoked session probes where it
expects 401; both requests were denied, but that assertion needs reconciliation
before the session-revocation check is called clean.

## Worker event correlation check — revision 70

After PRs [#221](https://github.com/myota-platform/myota-next/pull/221) and
[#224](https://github.com/myota-platform/myota-next/pull/224), protected rollout
[40638471527](https://github.com/myota-platform/myota-next/actions/runs/40638471527)
deployed chart `myota-next-1.1.6-testing.cb48c2a0fe92.1` at Helm revision 70.
All 17 Deployments were Ready. A test Participant login and subsequent
`/v1/identity/me` request both returned HTTP 200 with request ID
`0d9bda80-602c-43a2-ae73-3026c1b2cbff`.

The in-cluster receiver recorded that ID as a trace ID and forwarded log trace
ID for both `gateway` and `identity-api`. The `activity-notifications` worker
also delivered an Observe batch containing a snapshot with that ID, confirming
correlation from the login request through its asynchronous event handler. Its
batch had no forwarded log or operation name. The bounded
`myota_activity_notification_outcomes_total{outcome="processed"}` counter
increased from 2 to 3 during this check. Worker event trace correlation is
verified for this flow; worker log coverage, other worker operations, hosted
Observe delivery, per-email trace coverage, and behavioral alert qualification
remain open under Phase 6 issues [#90](https://github.com/myota-platform/myota-next/issues/90)
and [#91](https://github.com/myota-platform/myota-next/issues/91).

## Worker log and alert check — revision 72

Protected rollout [40645993158](https://github.com/myota-platform/myota-next/actions/runs/40645993158)
deployed chart `myota-next-1.1.6-testing.b6a158aeadad.1` at Helm revision 72.
All 17 Deployments (22 requested replicas) are Ready, and all 17 Prometheus
targets are up.

A synthetic failed login for a non-existent address returned HTTP 400 and did
not create an account. The request ID
`e8afbf2b-787b-4d2c-b3f1-044b94f34c2d` was recorded as a trace ID and forwarded
log trace ID at Gateway, Identity API, and Activity Notifications. The worker
emitted a structured settlement log for the processed event, with delivery
count 1. No external email or notification was sent.

All seven MyOTA Prometheus rules loaded with healthy evaluation. Two outbox
dead-letter alerts were firing for existing Core and Geodata dead-letter
counts, labeled with `service_id=outbox-worker`. The test Alertmanager has no
notification receiver, so external alert delivery remains unqualified. Hosted
Observe delivery and other asynchronous worker operations remain open under
[#90](https://github.com/myota-platform/myota-next/issues/90) and
[#91](https://github.com/myota-platform/myota-next/issues/91).

### Password-recovery request trace and token scan — revision 73

On 2026-10-28, a password-recovery request with a unique `X-Request-ID` returned
HTTP 200 from the deployed Identity API. The test receiver accepted an `identity-api`
batch containing that request ID and a recovery operation. The reset token was read
in memory from the Mailpit message; neither the exact token nor a `resetToken=` link
appeared in any `myota-test` pod log. The test receiver logs only the service ID,
request ID, and operation name, so raw OTLP attributes were not available for
field-level inspection. The test recovery
rows and generated Mailpit message were invalidated or deleted afterward. This confirms
trace delivery and pod-log token exclusion, not token exclusion from every trace field
or hosted Observe delivery. See
[Participant password reset](https://github.com/myota-platform/myota-next/issues/114).

### Deployed raw-batch scanner check — 2026-10-29

After PR [#302](https://github.com/myota-platform/myota-next/pull/302) passed
post-merge Node CI ([run 40798409242](https://github.com/myota-platform/myota-next/actions/runs/40798409242)),
the test-only collector was updated in `myota-test` and its Deployment rolled
out Ready. A synthetic request ID and marker were registered, then sent in a
gzip telemetry batch. The deployed scanner returned `requestObserved: true`
and `tokenObserved: true`; the marker did not appear in collector logs, and
the temporary scan state was deleted. No participant credential or real reset
token was used. This proves the deployed scanner examines raw accepted batches
and returns only booleans.

A second scan registered a synthetic marker and submitted it as the `token`
value to the deployed `POST /v1/identity/auth/recovery/reset` endpoint with a
unique `X-Request-ID`. The endpoint returned HTTP 400 for the invalid token.
The scanner observed the request in both Gateway and Identity telemetry while
returning `tokenObserved: false`. The marker was absent from Gateway, Identity,
and mock collector logs; the scan state was deleted. This checks token-field
exclusion on the deployed reset endpoint without using a valid credential. The
valid Mailpit reset flow is documented in the
[Identity parity record](../parity/identity-programmes.md). Hosted Observe
delivery remains open under [#90](https://github.com/myota-platform/myota-next/issues/90)
and Phase 6 issue [#10](https://github.com/myota-platform/myota-next/issues/10).
