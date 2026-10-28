# MyOTA Prometheus alerts

The Helm chart can install MyOTA alert rules alongside its API and worker
ServiceMonitors. Alert rules are optional by default. The isolated `myota-test`
release enables them and adds the `release: kube-prometheus-stack` label
required by this cluster's Prometheus rule selector.

## Rules

The chart currently defines these alerts:

- **Scrape target unavailable** — a MyOTA metrics target in the release
  namespace has been down for two minutes.
- **API server errors** — an API service recorded at least five HTTP 5xx
  responses in ten minutes, sustained for five minutes.
- **Worker dependency unavailable** — a worker reports a disconnected NATS or
  PostgreSQL dependency for two minutes.
- **Worker work failures** — failed, dead-lettered, or unsettled worker work
  was recorded during the last ten minutes.
- **Outbox dependency unavailable** — an outbox relay reports an unavailable
  database or NATS connection for two minutes.
- **Unresolved dead letters** — an outbox or Activity notification dead-letter
  gauge remains above zero for two minutes.

Rules attach the stable `service_id` label where the source metric provides it.
The scrape-target alert derives that label from the release-prefixed Service
name. API, worker, and outbox alerts preserve the owning service identifier and
add useful dimensions such as work type or dependency. Alert descriptions point
operators to service logs, traces, and dependency health; they do not include
request payloads or credentials.

## Configure

Set the chart values for the intended Prometheus Operator installation:

```yaml
prometheus:
  serviceMonitor:
    enabled: true
  rules:
    enabled: true
    labels:
      release: kube-prometheus-stack
```

The selector label must match the installed Prometheus resource. Keep rules
disabled when the Prometheus Operator CRDs are unavailable. The chart creates
`PrometheusRule` resources only when `prometheus.rules.enabled` is true.

## Verify

Check that Kubernetes accepted the rule resource and that Prometheus loaded the
alerts:

```sh
kubectl -n myota-test get prometheusrule myota-test-alerts
```

In Prometheus, open **Status → Rules** and confirm the `myota.api` and
`myota.delivery` groups are loaded. The HTTP API can also confirm rule discovery
at `/api/v1/rules`. Query the corresponding source metrics to inspect the
current service IDs and values.

These rules define alert conditions; the cluster's Alertmanager routes and
notification receivers remain separately configured. Confirm that routing and
delivery with the infrastructure owner before relying on notifications. Do not
create production notifications as part of test qualification.

### Test-cluster baseline — 2026-10-28

Before installing these rules, Prometheus reported all 17 MyOTA test scrape
targets up. The outbox gauge showed 49 unresolved Core dead letters and five
unresolved Geodata dead letters, so `MyOTAUnresolvedOutboxDeadLetters` is
expected to become active after the two-minute hold period until those records
are resolved. The deployed Alertmanager configuration has no notification
receiver. This baseline allows rule discovery and firing-state checks without
email or webhook delivery; notification delivery remains unqualified.
