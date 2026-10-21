# Implementation status

This repository is a clean Node.js and NestJS implementation of MyOTA, based
on the pinned [`myota` reference](https://github.com/myota-platform/myota/tree/7f904a5130e59006765cf882956a4adbfecb17ec).
The [parity matrix](parity-matrix.md) is the acceptance inventory; this page
summarizes implementation coverage and remaining gates.

## In place

- Node.js 24, NestJS 12, and `@nestjs/observe` across the independently
  startable API and worker applications.
- Exactly three application databases: Core for Identity, Programmes, and
  Email; Activity; and Geodata with PostGIS. Services own their schemas and do
  not join across databases.
- API and worker implementations for Identity, Programmes, Activity, Geodata,
  and Email, including the documented durable work, outbox, retry, lease, and
  redrive flows.
- Separate Admin and Participant applications, with browser coverage for key
  account, programme, Geodata, Activity, and award workflows.
- Workspace build, static checks, container images, local Compose, and Helm
  deployment definitions.

These items describe implementation coverage, not complete function parity or
production readiness.

## Remaining gates

- **Behavioral parity:** qualify request, authorization, persistence, failure,
  and workflow behavior for the required operations and events. The parity
  pages record current coverage and gaps; route presence alone is not proof.
- **Recovery:** single-server JetStream restart, selected worker lease recovery,
  redrive, and Geodata multipart object-store recovery have evidence. PostgreSQL
  outage, cluster failover, and other worker and object-store recovery paths
  remain open. See [worker and operations coverage](parity/workers-operations.md)
  and the [object-store recovery notes](operations/object-store-recovery.md).
- **Data transition:** disposable-database transfer, backup, and restore paths
  are exercised. Production-sized rehearsal, destination grants, external-state
  reconciliation, and rollback for writes accepted after cutover remain open.
  See [cross-version transfer](operations/cross-version-data-transfer.md).
- **Web applications:** current browser workflows use intercepted API
  responses. Service integration, broader payload coverage, accessibility,
  responsive behavior, and failure states remain to be qualified.
- **Production operations:** qualify persistent database operations, NATS,
  object storage, secrets, observability, deployment, and release automation.
- **Geodata performance:** larger datasets and full worker throughput remain
  unqualified. Python thread-pool limits do not map directly to Nest durable
  consumer concurrency; compare throughput and resource use before tuning.

## References

- [Function parity matrix](parity-matrix.md) and its [detailed behavior pages](parity/): requirements, coverage, and known differences.
- [Implementation plan](implementation-plan.md): migration sequence and exit gate.
- [API baseline](api-baseline.md) and [operation traceability](api-operation-traceability.md): contract operations and controller ownership.
- [Database backup and restore](operations/database-backup-restore.md) and [deployment guide](../deploy/README.md): operational procedures and deployment state.

This repository is a development baseline. Do not use it for production cutover
until the parity and operational gates above are closed.
