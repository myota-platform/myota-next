# Workers and operations

- Activity workers: QSO ingestion, ADIF processing, award evaluation and
  recalculation, certificate rendering, and statistics rebuild are consumed
  from their registered JetStream durables up to each durable's configured
  `max_ack_pending` concurrency. Database leases and message progress
  acknowledgements protect long jobs. Heartbeat timers are cancelled when
  processing settles, and long scheduled waits are cleared on shutdown.
  Notifications are handled by the separate consumer described below. ADIF
  source-object retention is scheduled, and queued jobs missing an outbox
  command are repaired periodically. A process-kill qualification covers
  statistics-rebuild lease takeover; other job kinds, broker outages, and
  retention recovery evidence remain open.
- Identity maintenance: expired recovery tokens, revoked sessions, expired
  revocations, rate-limit windows, old security events, and aged orphan profile
  images are cleaned by a separate Core-owned worker.
- Activity notification consumption: exact durable validation, transactional
  processed-event/checkpoint and notification writes, deduplication, bounded
  retry, redacted poison-event dead-lettering, and audited CLI redrive are
  implemented, with outcome and unresolved-dead-letter metrics. If NATS setup
  fails after connecting, the Nest worker now drains that connection before
  startup exits, matching the Python consumer's cleanup path. A disposable
  JetStream CI test also verifies that two Nest replicas share the durable, a
  restarted replica resumes it, and an audited CLI redrive republishes and
  resolves a retained dead letter. Its eight-delivery policy configures the
  seven delays that can precede redelivery; NATS rejects a backoff list as long
  as `max_deliver`. Falsey event types use the Python worker's `unknown`
  fallback in poison-event records.
  Named replay
  durables require an explicit start sequence, and optional message limits allow
  bounded replay runs. A recovery test restarts a single-server JetStream with
  file storage retained and verifies delivery resumes with confirmed ACKs and
  duplicate-event idempotency. Cluster failover, database-outage, and retry
  exhaustion recovery qualification remain open.
- Geodata workers: registered JetStream consumers for import preprocessing and
  promotion, confirmed entity deletion, and location enrichment are implemented.
  Each durable is polled concurrently up to its registered `max_ack_pending`
  limit.
  `/healthz` and `/readyz` expose liveness and Geodata PostgreSQL/NATS
  readiness. Worker heartbeat timers clear when jobs finish, and worker and
  scheduled-import polling delays are cancelled on shutdown. Import run leases
  and database heartbeats use the Python-compatible
  `MYOTA_IMPORT_LEASE_SECONDS` and `MYOTA_IMPORT_HEARTBEAT_SECONDS` settings.
  A transient database heartbeat failure is logged and retried at the next
  interval while the work task and JetStream ACK extensions continue; a
  confirmed lost lease still fails the work. This follows the Python import
  heartbeat thread's transient-error behavior. Cancellation reconciliation
  uses `GEODATA_CANCELLATION_RECONCILE_SECONDS`
  (default 30 seconds, minimum 5); JetStream ACK extensions follow one third of
  the registered durable ACK wait. Optional `GEODATA_WORKER_ACK_WAIT_SECONDS`,
  `GEODATA_WORKER_MAX_ACK_PENDING`, and `GEODATA_WORKER_MAX_DELIVERIES` settings
  are shared by JetStream provisioning and worker policy validation. The
  per-durable `GEODATA_WORKER_PREPROCESSING_MAX_ACK_PENDING`,
  `GEODATA_WORKER_PROMOTION_MAX_ACK_PENDING`,
  `GEODATA_WORKER_DELETION_MAX_ACK_PENDING`, and
  `GEODATA_WORKER_ENRICHMENT_MAX_ACK_PENDING` settings override the global
  pending limit and are applied consistently at provisioning and runtime.
  The reference Python API also exposes separate thread-pool limits. The
  NestJS runtime uses durable consumer concurrency for persisted work, so these
  settings do not all translate to the same execution boundary:

  | Python setting           | Python work                                                    | NestJS counterpart                                                                                                         | Compatibility status                                       |
  | ------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
  | `MYOTA_UPLOAD_WORKERS`   | API-local completion and recovery of uploaded source objects   | Upload admission and object handoff stay in Geodata API; preprocessing starts on the worker durable                        | No direct worker-concurrency alias                         |
  | `MYOTA_IMPORT_WORKERS`   | In-process import preprocessing, promotion, and recovery tasks | `geodata-preprocessing-v1` and `geodata-import-promotion-v1`, each with its own `GEODATA_WORKER_*_MAX_ACK_PENDING` setting | Split into two independently tunable durables              |
  | `MYOTA_LOCATION_WORKERS` | In-process location-enrichment tasks                           | `geodata-location-enrichment-v1` with `GEODATA_WORKER_ENRICHMENT_MAX_ACK_PENDING`                                          | Accepted as a fallback alias; queue and lease model differ |
  | `MYOTA_DELETION_WORKERS` | In-process entity-deletion tasks                               | `geodata-entity-deletion-v1` with `GEODATA_WORKER_DELETION_MAX_ACK_PENDING`                                                | Accepted as a fallback alias; queue and lease model differ |

  The Nest runtime accepts only the matching location and deletion settings as
  fallback aliases; explicit per-durable and shared Nest settings take
  precedence. It does not alias `MYOTA_UPLOAD_WORKERS` or `MYOTA_IMPORT_WORKERS`:
  upload completion remains API-local, while import work is split across
  preprocessing and promotion durables. Do not infer concurrency parity from
  equal numbers: a Python pool is shared across task submissions, while each
  Nest durable has an independent pending limit and can run in multiple worker
  replicas. Before operational parity is qualified, compare per-work
  throughput and resource limits under representative loads, then tune the
  registered durable policies and worker replica counts together.
  The Geodata API exposes `/metrics` with PostGIS tile-query duration and
  slow-query counters; `MYOTA_SLOW_QUERY_THRESHOLD_MS` retains its 250 ms
  default and controls the slow-query counter. The reference's `entity_upsert`
  series timed a full-snapshot synchronization pass; the row-authoritative
  implementation has no equivalent pass and does not reuse that label for
  individual writes.
  Stale queued and expired work is re-enqueued through the owner outbox.
  A live-worker CI check restarts a single-server JetStream with its file store
  retained and verifies all four registered work durables process new work
  after reconnection. The same check simulates a preprocessing repository
  failure, makes the status lookup fail, then restores repository access and
  verifies JetStream redelivery completes the work. This fault injection does
  not stop PostgreSQL; actual database-outage and clustered failover recovery
  remain open.
  Scheduled import and upload-session retention is implemented. CI restarts the
  pinned SeaweedFS image during a Geodata multipart upload, verifies a failed
  part leaves no database record, retries it after restart, and checks the
  completed object and queued import. Other object-store and worker outage paths
  remain open; see [object-store recovery](../operations/object-store-recovery.md).

- Gateway: routes public API requests to their owning services, protects
  Identity internal endpoints, streams request and response bodies, enforces
  configured proxy timeouts, and resolves Grafana identity and permissions from
  the live Identity service. All five APIs expose service/method/route/status
  request counters at `/metrics`; Gateway also retains its proxy-specific
  counters.
- Outbox relay: independently configured Core, Activity, and Geodata relay
  processes claim only their own database's events and publish registered fact
  or work envelopes to JetStream with stable event IDs and validates existing
  stream and durable settings at startup, validates registered work payloads,
  and exposes Prometheus metrics.
  `npm run outbox:admin` lists bounded dead-letter metadata and transactionally
  redrives one retained event against its owning database, recording the prior
  attempts and error. See [outbox recovery](../operations/outbox-recovery.md).
  CI runs the same fault-injection check against Core, Activity, and Geodata
  separately: a transient publish failure leaves the owner-scoped outbox row
  retryable, then JetStream accepts the retry and the row is marked published.
  It also exhausts retries for an owner-scoped event, invokes the audited
  redrive CLI, verifies the recorded prior attempts and error, and confirms
  successful republishing resolves the dead letter. A second check starts an
  isolated JetStream server for each owner, kills it after an outbox claim,
  verifies the event stays retryable, restarts the server with its file store,
  and confirms publication after client reconnection. Cluster failover and
  deployment-level NATS recovery remain unqualified.
- Runtime: preserve migrations, health/readiness, metrics, logs, traces,
  backups, restore paths, NATS topology, object storage buckets, and separate
  service/worker deployment units. Activity database pools honor the
  `MYOTA_ACTIVITY_DB_POOL_MAX` override before `MYOTA_DB_POOL_MAX`, defaulting
  to 12 connections; Core and Geodata use the shared override and default to 10.
