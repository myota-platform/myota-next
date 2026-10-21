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
  redrive, Geodata multipart object-store recovery, and a three-owner backup and
  restore rehearsal have evidence. PostgreSQL outage, cluster failover, and
  other worker and object-store recovery paths remain open. See
  [worker and operations coverage](parity/workers-operations.md), the
  [database backup and restore notes](operations/database-backup-restore.md),
  and the [object-store recovery notes](operations/object-store-recovery.md).
- **Web applications:** CI exercises Admin sign-in/dashboard, Identity account
  creation and callsign management through export and anonymization, Activity
  correction review, and policy publication against running NestJS services
  through the Gateway. Participant owner callsign creation, evidence
  submission, primary selection, and retirement also run against live Identity
  APIs. Participant public catalogue loading uses the live services as well.
  Most other browser workflows still use intercepted API responses;
  broader payload coverage, accessibility, responsive behavior, and failure
  states remain to be qualified.
- **Production operations:** qualify persistent database operations, NATS,
  object storage, secrets, observability, deployment, and release automation.
- **Geodata performance:** larger datasets and full worker throughput remain
  unqualified. `MYOTA_UPLOAD_WORKERS` caps multipart finalization per Geodata
  API process. `MYOTA_IMPORT_WORKERS` caps preprocessing and promotion together
  per worker process when native concurrency settings are absent. Replicas
  multiply these process-local limits; compare throughput and resource use
  before production tuning.

## References

- [Function parity matrix](parity-matrix.md) and its [detailed behavior pages](parity/): requirements, coverage, and known differences.
- [Implementation plan](implementation-plan.md): implementation sequence and exit gate.
- [API baseline](api-baseline.md) and [operation traceability](api-operation-traceability.md): contract operations and controller ownership.
- [Database backup and restore](operations/database-backup-restore.md) and [deployment guide](../deploy/README.md): operational procedures and deployment state.

This repository is a development baseline. Do not use it in production until
the parity and operational gates above are closed. The current goal starts from
empty databases and excludes transfer from the old platform.
