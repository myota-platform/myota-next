# Runtime language options

## Decision status

Node.js and NestJS remain the selected implementation baseline, following the
user's explicit choice. This document compares alternatives without changing
that decision. Any switch to another stack requires the user's direction. There
is no apples-to-apples runtime benchmark for this platform, so this document
does not claim that one candidate is faster for MyOTA as a whole.

## Workload to optimize

MyOTA combines database-backed API requests, NATS workers, object storage, and
Geodata import and transformation. The Geodata import path has the clearest
CPU-heavy work: decoding large formats, validating records, transforming
coordinates, and preparing database batches. Spatial reads also depend on
PostgreSQL/PostGIS query plans and indexes. PostGIS documents GiST spatial
indexes as a key way to accelerate spatial queries ([indexing guidance](https://postgis.net/documentation/faq/spatial-indexes/)).
Changing the API language alone would not speed up work dominated by database,
broker, or object-store waits.

## Candidates

| Candidate          | Potential fit                                                                                                                                                  | Cost and evidence needed                                                                                                                                                                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js / NestJS   | Preserves the existing implementation and its shared TypeScript contracts. Its asynchronous I/O model fits API and worker coordination.                        | CPU-heavy JavaScript can block the event loop; Node recommends moving CPU-intensive work to worker threads or another worker pool ([Node.js guidance](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop)). Profile Geodata import before deciding that a full rewrite is warranted. |
| Java / Spring Boot | A compiled, mature service stack with broad database and enterprise integration options. Virtual threads can raise throughput for blocking-I/O server designs. | Virtual threads improve concurrency rather than the speed of CPU-bound code ([Oracle guidance](https://docs.oracle.com/en/java/javase/21/core/virtual-threads.html)). Rebuild the services and preserve Python-compatible behavior, contracts, and the three database owners.                             |
| Go                 | A compiled service stack with a small runtime model and built-in concurrency primitives.                                                                       | The official Go FAQ describes compilation speed, not comparative application throughput ([Go FAQ](https://go.dev/doc/faq)). Validate spatial-format and projection library coverage, behavior compatibility, and memory use against the real import corpus.                                               |

## Comparison needed before a stack change

Use the same representative workloads, data, database schema, resource limits,
and output checks for each candidate. Measure API latency and throughput,
Geodata import throughput and peak memory, worker recovery behavior, and
operational image size and startup. Keep PostGIS query plans and indexes
constant so a language result is not actually a database-plan difference.

Until a candidate demonstrates a material improvement on the workload that
matters, replacing the current implementation adds a large parity-rebuild cost
without measured performance evidence. The current Node.js/NestJS stack remains
in place unless the user directs a change.
