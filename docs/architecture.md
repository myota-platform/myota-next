# Target architecture

This document records the target boundaries and selected runtime. The user
selected Node.js with NestJS; applications will be written in TypeScript.

## Processes and ownership

Keep four independently startable and deployable domain APIs, their workers,
one API gateway, and two separate browser applications. Services own their
authorization rules, domain transactions, persistence, migrations, and
background work. The gateway routes requests and applies edge concerns; it
does not become a domain service.

### Identity

- **Owns:** Accounts, credentials, sessions, callsigns, roles, scopes, and
  security events.
- **Database:** Core PostgreSQL.

### Programmes

- **Owns:** Programme configuration, content, policy drafts, shared entity
  categories, and programme assignments.
- **Database:** Core PostgreSQL.

### Activity

- **Owns:** Activations, QSOs, imports, statistics, awards, execution jobs,
  and notification records.
- **Database:** Activity PostgreSQL.

### Geodata

- **Owns:** Spatial catalogue, imports, provenance, review, conflation, and
  enrichment.
- **Database:** Geodata PostgreSQL with PostGIS.

### Admin web

- **Owns:** Authorized administrative workflows.
- **Database:** None.

### Participant web

- **Owns:** Participant-facing browse and account workflows.
- **Database:** None.

## Data boundaries

Preserve three independently addressable databases: `myota_core`,
`myota_activity`, and `myota_geo`. Core and Activity use plain PostgreSQL;
Geodata requires PostGIS. Each database has its own schema migrations,
connection pool, operational records, backups, and recovery procedures.

Do not create cross-database foreign keys or transactions. Represent
cross-service relationships with stable opaque IDs and exchange committed
facts or commands through APIs and the event/work transport. Keep service-local
outbox, idempotency, checkpoint, lease, and dead-letter records beside the
owning domain data.

Programme-scoped entity numbering follows the same boundary: Core owns each
programme's numbering policy and globally reserved programme identifier;
Geodata owns the assigned entity ID and serial-allocation state. Geodata reads
the current policy through the Programmes API, then allocates and stores the ID
in the same Geodata transaction as the entity mutation. Policy changes never
rewrite assigned IDs, and no transaction spans the Core and Geodata databases.

Geodata JSON writes with an `Idempotency-Key` share the request contract in
[`geodata-request-idempotency.ts`](../apps/geodata/src/geodata-request-idempotency.ts):
keys are scoped by authenticated owner and request URL, request fingerprints
reject changed-body reuse, and successful results are stored with the owning
Geodata transaction. Resumable upload sessions retain their session-specific
owner and part-checksum rules.

Map payloads are compressed at the Traefik ingress when the client advertises
Brotli, with gzip fallback. Admin-host API responses use the same negotiated
compression middleware as the public API and participant API routes. See the
[map rendering strategy](map-rendering.md) for zoom simplification, viewport
limits, and the distinction between display geometry and stored geometry.

## Asynchronous work

Persist work intent and domain state in the owning database before publishing.
Use transactional outboxes, bounded NATS JetStream streams, explicit durable
consumers, post-commit acknowledgements, idempotent handlers, leases, bounded
redelivery, audited dead-letter handling, and recovery scans. NATS is delivery
infrastructure; it is not the source of truth or a permanent event archive.

Preserve the three current stream purposes: bounded domain facts, Activity
work, and Geodata work. Work remains owned by the Activity or Geodata service
even when several worker replicas process it.

Run one outbox relay instance group for each owning database (`core`, `activity`, and
`geodata`). Each process receives only that database's `OUTBOX_DATABASE_URL`, plus
`OUTBOX_OWNER`, `NATS_URL`, and the shared event registry. The relay uses `Nats-Msg-Id`
from the durable outbox event ID so a broker acknowledgement followed by a database
update failure can be retried safely. It retries transient publish failures with bounded
backoff and stores permanent or exhausted failures in the owning database's dead-letter
table.

Each process exposes Prometheus metrics at `/metrics` on port 9108 by default; set
`OUTBOX_METRICS_PORT=0` to disable the listener. Do not point one relay at multiple
databases or combine their transactions. The Activity notification consumer exposes its
outcome and unresolved dead-letter metrics at `/metrics` on port 9110 by default; set
`ACTIVITY_NOTIFICATION_METRICS_PORT=0` to disable the listener.

## Shared runtime dependencies

Keep the existing API contracts and event schemas compatible while replacing
the implementation. Preserve S3-compatible object storage for profile images,
imports, award assets, and generated certificates. Keep metrics, logs, traces,
health checks, and deployment configuration observable per process.

Use the Nest CLI monorepo layout for independently startable API and worker
applications. Use Node.js 24 LTS and NestJS 12 as the
initial runtime baseline. Persistence libraries remain an implementation
choice, but must support explicit SQL migrations, PostgreSQL transactions,
PostGIS operations, and clear connection ownership per service.

Place domain rules shared by a service API and its workers in a service-owned
library, such as `libs/geodata-domain`. Keep cross-cutting runtime facilities
in `libs/platform`; do not put service-specific validation there.

Within Activity, keep award definition, request, issuance, and asset persistence
in `ActivityAwardsRepository`; activation, QSO, ingestion, statistics, and
operational persistence stay in `ActivityRepository`. Both repositories use
the same Activity database owner and write award facts to its transactional
outbox.

Within Identity, keep account, profile, and role administration in
`IdentityAccountService`; callsign lifecycle operations belong in
`IdentityCallsignService`. Both use the Core database owner and retain their
existing authorization, transaction, idempotency, and outbox behavior.
