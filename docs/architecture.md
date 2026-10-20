# Target architecture

This document records the target boundaries and selected runtime. The user
selected Node.js with NestJS; applications will be written in TypeScript.

## Processes and ownership

Keep four independently startable and deployable domain APIs, their workers,
one API gateway, and two separate browser applications. Services own their
authorization rules, domain transactions, persistence, migrations, and
background work. The gateway routes requests and applies edge concerns; it
does not become a domain service.

| Component       | Owns                                                                                                | Database                        |
| --------------- | --------------------------------------------------------------------------------------------------- | ------------------------------- |
| Identity        | Accounts, credentials, sessions, callsigns, roles, scopes, security events                          | Core PostgreSQL                 |
| Programmes      | Programme configuration, content, policy drafts, shared entity categories and programme assignments | Core PostgreSQL                 |
| Activity        | Activations, QSOs, imports, statistics, awards, execution jobs, notification records                | Activity PostgreSQL             |
| Geodata         | Spatial catalogue, imports, provenance, review, conflation, enrichment                              | Geodata PostgreSQL with PostGIS |
| Admin web       | Authorized administrative workflows                                                                 | None                            |
| Participant web | Participant-facing browse and account workflows                                                     | None                            |

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

Geodata JSON writes with an `Idempotency-Key` share the request contract in
[`geodata-request-idempotency.ts`](../apps/geodata/src/geodata-request-idempotency.ts):
keys are scoped by authenticated owner and request URL, request fingerprints
reject changed-body reuse, and successful results are stored with the owning
Geodata transaction. Resumable upload sessions retain their session-specific
owner and part-checksum rules.

## Asynchronous work

Persist work intent and domain state in the owning database before publishing.
Use transactional outboxes, bounded NATS JetStream streams, explicit durable
consumers, post-commit acknowledgements, idempotent handlers, leases, bounded
redelivery, audited dead-letter handling, and recovery scans. NATS is delivery
infrastructure; it is not the source of truth or a permanent event archive.

Preserve the three current stream purposes: bounded domain facts, Activity
work, and Geodata work. Work remains owned by the Activity or Geodata service
even when several worker replicas process it.

Run one outbox relay instance group for each owning database (`core`,
`activity`, and `geodata`). Each process receives only that database's
`OUTBOX_DATABASE_URL`, plus `OUTBOX_OWNER`, `NATS_URL`, and the shared event
registry. The relay uses `Nats-Msg-Id` from the durable outbox event ID so a
broker acknowledgement followed by a database update failure can be retried
safely. It retries transient publish failures with bounded backoff and stores
permanent or exhausted failures in the owning database's dead-letter table.
Each process exposes Prometheus metrics at `/metrics` on port 9108 by default;
set `OUTBOX_METRICS_PORT=0` to disable the listener.
Do not point one relay at multiple databases or combine their transactions.
The Activity notification consumer exposes its outcome and unresolved
dead-letter metrics at `/metrics` on port 9110 by default; set
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
