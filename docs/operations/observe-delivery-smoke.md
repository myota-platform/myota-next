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
