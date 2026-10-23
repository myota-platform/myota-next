# ADR-0001: Node.js and NestJS runtime

## Status

Accepted. The user selected Node.js with the NestJS framework.

## Decision

- Write backend services in TypeScript and run them on Node.js 24 LTS.
- Use NestJS 12 for separately startable API and worker applications in a
  Nest CLI monorepo.
- Pin direct NestJS framework and CLI packages and commit `package-lock.json`.
- Keep CPU-heavy parsing and geospatial work in bounded worker processes; do
  not assume an event-loop runtime will speed up CPU-bound workloads.

## Rationale and limits

This is the requested runtime choice, not a claim of measured performance gain.
Geodata parsing, projection, conflation, and large import files may be
CPU-intensive. Compare representative latency, throughput, and memory against
the current implementation before drawing performance conclusions. I/O-bound
request handling, database access, and broker delivery should use bounded
concurrency and connection pools.

Node.js 24 is the pinned runtime major; the installed environment was Node
24.22.0. NestJS 12 requires Node.js 20 or newer according to its
[official setup guide](https://docs.nestjs.com/v12/first-steps). Verify the
supported runtime again when upgrading NestJS or Node.js. See the official
[Node.js releases](https://nodejs.org/en/about/previous-releases) for current
support status.

## Consequences

- The four APIs and background consumers share one typed application runtime
  while retaining separate process and data ownership.
- Existing SQL migrations, OpenAPI definitions, JSON Schemas, and event
  behavior remain language-neutral compatibility references.
- Database, NATS, and S3-compatible object storage libraries still require
  selection and service-specific qualification.
