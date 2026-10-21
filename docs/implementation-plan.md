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
Docker recipe are in place. GitHub Actions run static and build gates and
provide a gated workflow for publishing application images. Deployment
qualification remains open. Identity, Programmes, Activity, and Geodata have
substantial working slices. The platform starts with empty target databases;
transferring data from the old platform is out of scope. See the
[implementation status](status.md) and [parity matrix](parity-matrix.md) for
current coverage and known gaps.

## 2. Implement contract-shaped synchronous behavior

- NestJS controllers are mapped to all upstream OpenAPI operations. Identity
  and Programmes use owner-scoped relational persistence, and Gateway routing
  and authorization forwarding are implemented.
- Continue checking payload, authorization, error, and workflow behavior
  against the reference. Route coverage alone does not establish parity.

## 3. Implement Activity and Geodata domains

- Activity and Geodata APIs and workers implement the documented activity,
  import, award, rendering, review, and several recovery workflows. Preserve
  the Core, Activity, and Geodata database boundaries and their high-write and
  spatial query behavior.
- Continue resolving behavior gaps and qualifying worker recovery and
  throughput. See the parity matrix for specific differences and open evidence.

## 4. Carry forward and reconcile browser applications

- Admin and Participant applications are separate deployable artifacts and use
  the NestJS APIs. Admin route-to-contract mapping and local build checks are in
  place.
- Verify payloads, permission states, destructive and conflict flows, uploads,
  async progress, accessibility, and responsive behavior in browser workflows.

## 5. Prove parity and qualify fresh deployment

- Extend automated compatibility evidence across APIs, databases, workers, and
  browser workflows. Current CI static and build checks do not prove parity.
- Compare isolated API fixtures and representative results with the reference;
  do not transfer its database contents.
- Initialize Core, Activity, and Geodata from empty databases and qualify
  owner migrations, backups, and restore procedures.
- Exercise backups, restore, broker outage, worker restart, and object-store
  recovery before considering production deployment.

## Exit gate

No production deployment until the function parity matrix is fully traced to
code and compatibility checks, the three databases initialize cleanly and
have verified backup and restore procedures, worker recovery paths are
qualified, browser workflows pass, and deployment qualification succeeds in an
isolated environment. This repository is a development baseline. Use the
parity matrix for missing behavior and the status document for current
implementation.
