# Implementation sequence

Build the clean implementation in vertical slices. Do not start deployment
cutover or claim parity until each slice has behavioral evidence against the
current reference.

## 0. Freeze the behavioral baseline

- Record the exact reference commit and snapshot all language-neutral
  contracts, event registry, schemas, and migration files.
- The reference OpenAPI, event registry, and 81 JSON schemas are preserved in
  [`contracts/reference/`](../contracts/reference/), with SHA-256 checksums.
- The eight original application/deployment migration files are preserved in
  [`docs/reference/migrations/`](reference/migrations/) for schema-by-schema
  comparison; active migrations remain under `deploy/db/migrations/`.
- Inventory API operations, event producers/consumers, worker kinds, UI routes,
  database tables, object storage buckets, environment settings, and runbooks.
- Map the 135 upstream OpenAPI operations across 113 paths to service handlers
  and compatibility evidence. Track the five target-only API extensions listed
  in [`api-baseline.md`](api-baseline.md) separately from upstream parity.
- Keep the [API operation traceability index](api-operation-traceability.md)
  mapped to target controller sources, then link each operation to behavioral
  compatibility evidence as it is established. Resolve ambiguities against
  current reference source and contract behavior.

## 1. Establish the new runtime

- Create reproducible npm workspace builds, formatting, static analysis, test,
  and container workflows for the selected Node.js/NestJS stack.
- Implement service startup, configuration validation, health/readiness,
  structured logs, metrics, tracing, and graceful shutdown.
- Start each process independently while retaining the three database targets.

The Node 24/NestJS workspace, separate service and worker entry points,
database-aware readiness, copied contracts and migrations, formatting, lint,
typecheck, build gates, an owner-scoped migration runner, and a per-application
Docker recipe are in place, with GitHub Actions running the static and build
gates on pushes and pull requests. Image publication, data transfer, and
deployment qualification remain open. Identity, Programmes, Activity, and
Geodata each have working vertical slices. See the [implementation status](status.md)
and [parity matrix](parity-matrix.md) for current coverage.

## 2. Implement contract-shaped synchronous behavior

- Finish contract coverage for Identity and Programmes.
- Implement Gateway routing and authorization forwarding.
- Add migration-based persistence and compatibility coverage before expanding
  behavior.

## 3. Implement Activity and Geodata domains

- Finish Activity and Geodata APIs, workers, recovery, and redrive.
- Preserve the Core, Activity, and Geodata database boundaries and their
  high-write and spatial query behavior.
- Port remaining file formats, uploads, rendering, and domain rules with
  compatibility coverage.

## 4. Carry forward and reconcile browser applications

- Keep the baseline Admin and Participant applications as separate deployable
  artifacts while reconciling their API dependencies to the Nest services.
- Implement all baseline routes and permission states against the new APIs.
- Cover destructive, conflict, upload, async progress, accessibility, and
  responsive behaviors with browser tests.

## 5. Prove parity and prepare data transition

- Run contract, service, database, worker, integration, browser, image, and
  deployment checks in CI.
- Compare seeded datasets and representative API results with the reference.
- Design a repeatable export/import, row-count and consistency verifier, and
  rollback procedure for each database; test these on disposable copies.
- Exercise backups, restore, broker outage, worker restart, and object-store
  recovery before considering a production transition.

## Exit gate

No cutover until the function parity matrix is fully traced to code and tests,
the three databases have verified migration/transfer and restore procedures,
all worker recovery paths are proven, browser workflows pass, and deployment
qualification succeeds in an isolated environment. This repository is a
development baseline, not a production cutover candidate. Use the parity matrix
for missing behavior and the status document for current implementation.
