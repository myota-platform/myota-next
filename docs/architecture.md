# Target architecture

This document records the target boundaries and selected runtime. The user
selected Node.js with NestJS; applications will be written in TypeScript.

## Processes and ownership

Keep four independently startable and deployable domain APIs, their workers,
one API gateway, and two separate browser applications. Services own their
authorization rules, domain transactions, persistence, migrations, and
background work. The gateway routes requests and applies edge concerns; it
does not become a domain service.

| Component | Owns | Database |
|---|---|---|
| Identity | Accounts, credentials, sessions, callsigns, roles, scopes, security events | Core PostgreSQL |
| Programmes | Programme configuration, content, policy drafts, shared entity categories and programme assignments | Core PostgreSQL |
| Activity | Activations, QSOs, imports, statistics, awards, execution jobs, notification records | Activity PostgreSQL |
| Geodata | Spatial catalogue, imports, provenance, review, conflation, enrichment | Geodata PostgreSQL with PostGIS |
| Admin web | Authorized administrative workflows | None |
| Participant web | Participant-facing browse and account workflows | None |

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

## Asynchronous work

Persist work intent and domain state in the owning database before publishing.
Use transactional outboxes, bounded NATS JetStream streams, explicit durable
consumers, post-commit acknowledgements, idempotent handlers, leases, bounded
redelivery, audited dead-letter handling, and recovery scans. NATS is delivery
infrastructure; it is not the source of truth or a permanent event archive.

Preserve the three current stream purposes: bounded domain facts, Activity
work, and Geodata work. Work remains owned by the Activity or Geodata service
even when several worker replicas process it.

## Shared runtime dependencies

Keep the existing API contracts and event schemas compatible while replacing
the implementation. Preserve S3-compatible object storage for profile images,
imports, award assets, and generated certificates. Keep metrics, logs, traces,
health checks, and deployment configuration observable per process.

Use npm workspaces for the repository and NestJS applications for independently
startable API and worker processes. Use Node.js 24 LTS and NestJS 12 as the
initial runtime baseline. Persistence libraries remain an implementation
choice, but must support explicit SQL migrations, PostgreSQL transactions,
PostGIS operations, and clear connection ownership per service.
