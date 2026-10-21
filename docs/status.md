# Implementation status

This repository is a clean Node.js and NestJS implementation of MyOTA. The
current reference is the pinned [`myota` commit](https://github.com/myota-platform/myota/tree/7f904a5130e59006765cf882956a4adbfecb17ec).
Track required behavior and known differences in the [parity matrix](parity-matrix.md);
this page summarizes the current state and remaining release gates.

## Implemented

- **Runtime:** Node.js 24, NestJS 12, and independently startable API and
  worker applications. The shared platform package provides health checks,
  metrics, tracing, request handling, and database access. All NestJS
  applications use `@nestjs/observe`.
- **Data ownership:** exactly three application databases: Core for Identity,
  Programmes, and Email; Activity; and Geodata with PostGIS. Services own their
  migrations and do not join across databases.
- **APIs and workers:** initial and extended Identity, Programmes, Activity,
  Geodata, and Email slices are implemented. Durable jobs, transactional
  outboxes, leases, retries, dead letters, and audited redrive are present for
  the documented workflows.
- **Web applications:** Admin and Participant applications are separate
  deployable artifacts and use the NestJS APIs. The Admin build is part of CI.
  Chromium browser checks cover Admin sign-in, session bootstrap, scope denial,
  account creation with a permitted role grant, custom-role creation, programme
  creation, policy draft review/publication, version-checked Geodata review,
  and Geodata entity metadata conflict recovery by explicitly reloading the
  latest server version; Activity activation/QSO details, statistics rebuild
  submission, and job status refresh; award draft creation, review, and
  publication; shared category creation with geometry and inactive lifecycle
  settings; Geodata conflation decisions with survivor and reviewer notes;
  refresh schedule creation and manual complete-snapshot submission;
  Participant catalogue browsing, activation and QSO lifecycle, profile details
  and image editing, eligible award requests, and candidate and map-picked point
  proposals.
- **Build and deployment:** CI builds the NestJS applications and container
  images. Helm charts describe the applications and optional single-instance
  PostgreSQL for the three owners. Local Compose provisions the development
  stack.

These items describe implementation coverage; they do not establish full
behavioral parity or production readiness.

## Remaining work

- Add compatibility evidence for the implemented API and worker behavior.
- Exercise worker restart, broker and object-store outages, retries, recovery,
  and redrive against disposable infrastructure.
- Complete the semantic review and rehearsal for cross-version database
  transfer, backup, restore, and rollback.
- Expand browser workflow checks across Admin and Participant payload parity,
  accessibility, responsive behavior, and failure states.
  Current browser checks use intercepted API responses and do not test
  deployment or service integration.
- Qualify production deployment, persistent database operations, NATS topology,
  object storage, secrets, observability, and release automation.
- Compare Geodata worker throughput and resource limits with the reference under
  representative loads. Per-durable NestJS concurrency is configurable, but
  the reference thread-pool settings do not map directly to its durable
  consumers.

## References

- [Function parity matrix](parity-matrix.md): domain behavior, compatibility
  details, and known differences.
- [Implementation plan](implementation-plan.md): migration sequence and exit
  gate.
- [API baseline](api-baseline.md) and [operation traceability](api-operation-traceability.md):
  contract operations and NestJS route ownership.
- [Cross-version database transfer](operations/cross-version-data-transfer.md)
  and [backup and restore](operations/database-backup-restore.md): data
  transition procedures and open rehearsals.
- [Deployment guide](../deploy/README.md): Compose and Helm deployment state.

The monorepo is a development baseline. Do not use it for production cutover
until the parity and operational gates above are closed.
