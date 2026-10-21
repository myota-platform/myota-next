# MyOTA Next

This is a clean implementation of MyOTA, with the current platform used as the
behavioral reference. The goal is function parity across APIs, workers, web
applications, and operations while keeping service and data ownership explicit.

The source implementation and its contracts are being documented in
[`docs/parity-matrix.md`](docs/parity-matrix.md). The current OpenAPI document
and event schemas are copied into [`contracts/`](contracts/) as compatibility
anchors; the initial API inventory is in [`docs/api-baseline.md`](docs/api-baseline.md).
The reference implementation is MyOTA monorepo commit
`7f904a5130e59006765cf882956a4adbfecb17ec`.

## Selected baseline

- Implementation language: TypeScript on Node.js.
- Framework: NestJS.
- Workspace tooling: Nest CLI monorepo managed with npm; Node 24 LTS and
  NestJS 12.2.0 are the initial baseline versions.
- Keep three independent database targets: Core PostgreSQL, Activity
  PostgreSQL, and Geodata PostgreSQL with PostGIS.

See [runtime language options](docs/language-options.md) for the performance
tradeoffs under consideration before changing this baseline.

The persistence library and production runtime qualification remain open. Email
delivery now uses the Core database owner and a NestJS worker, while its Identity
producer, deployment, and full telemetry qualification remain gated. See
[implementation status](docs/status.md).

## Repository map

- `apps/identity` — accounts, authentication, callsigns, roles, and security.
- `apps/programmes` — programme configuration, policy, content, and categories.
- `apps/activity` — activations, QSOs, awards, statistics, and activity jobs.
- `apps/geodata` — spatial catalogue, imports, review, and enrichment.
- `apps/email-worker` — Core-owned JetStream email delivery consumer.
- `web/admin` and `web/participant` — separate browser applications.
- `contracts` — HTTP and event compatibility contracts.
- `deploy` — local Compose, owner-scoped database migrations, JetStream
  provisioning, and image build guidance.
- `docs` — architecture, behavior parity, and implementation gates.

See [`docs/architecture.md`](docs/architecture.md) for target boundaries and
[`docs/implementation-plan.md`](docs/implementation-plan.md) for the staged
parity sequence.

For the local Compose environment, see [`deploy/README.md`](deploy/README.md).
