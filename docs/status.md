# Implementation status

**Baseline reference:** MyOTA monorepo commit
`7f904a5130e59006765cf882956a4adbfecb17ec`.

## In place

- User-selected Node.js/NestJS runtime with Node 24 and NestJS 12.
- Nest CLI monorepo projects for Gateway, Identity, Programmes, Activity,
  Geodata, and the separate worker process slots.
- Shared `/healthz` liveness and `/readyz` readiness handlers. Identity and
  Programmes probe Core PostgreSQL, Activity probes Activity PostgreSQL, and
  Geodata probes PostGIS. Gateway readiness does not depend on a database.
- Current OpenAPI, event schemas, and three database migration baselines copied
  as compatibility references.
- First Identity slice: disabled public registration, password login, refresh
  rotation, logout revocation, recovery request/reset, current account and
  scope reads, owner-only profile updates, and paginated administrator account
  listing, account creation, role-catalogue reads, role creation, and role
  updates, account reads and active role reads for the account owner or global
  operator, and administrative account updates including profile, credentials,
  lifecycle, anonymization and role replacement. Callsign add, primary
  selection, evidence submission, verification, and retirement, plus paginated
  security-event reads for global administrators and owner-scoped account data
  export, scoped OIDC provider mapping creation/update, and five-minute service token
  issuance with the restricted email-recipient lookup, and normalized private
  profile-image upload/read/delete are also implemented.
  Authentication uses the existing scrypt hash format, HS256 token contract,
  persisted session, revocation, lockout and rate-limit tables.
- Transactional event helpers write domain events to the Core outbox and
  security events to both the security-event table and outbox.
- Programme listing, detail and effective-policy reads, plus scoped creation,
  update and archive transitions, now load and persist snapshots in Core with
  transactional outbox writes. Global entity-type catalogue management and
  per-programme entity-type reads, assignments and removals use the same state
  transaction and outbox boundary. Programme content supports draft editing,
  review submission and decisions, publication, paginated filtering, and locale
  coverage reporting. Programme policy drafts support scoped authoring,
  submission, review, publishing, and effective policy updates. These operations
  share a dedicated Core snapshot repository and transactional outbox boundary.
- Activity now has an initial API slice for activation listing, creation,
  retrieval, closure, and single-QSO recording. It persists normalized
  activations and QSOs in Activity PostgreSQL, writes domain events and
  idempotency responses transactionally, updates subject aggregates, and
  queues award recalculation work through the Activity outbox. High-volume QSO
  ingestion requests are authorized, bounded, persisted as Activity jobs, and
  exposed through an owner-scoped status API. The separate Activity worker
  processes these ingestion jobs transactionally with database leases, bounded
  retries, and dead-letter records. Public activation history masks operator
  callsigns, leaderboards use subject aggregates, and result exports support
  JSON and CSV. QSO correction requests and administrator review now use
  transactional Activity persistence; applying a correction queues award
  recalculation. Activity statistics can be listed and rebuild jobs queued,
  processed into versioned programme/category/entity/jurisdiction snapshots,
  and inspected; recipient notifications can be read with owner/admin checks.
  ADIF uploads are ownership-checked, size-limited, scanned, stored in S3, and
  queued transactionally; the Activity worker parses the source, persists QSOs,
  updates aggregates, records per-record errors, and updates the import status.
  Entity-deletion impact reads and idempotent cascades are implemented: the
  Activity service removes linked valid QSOs and corrections, invalidates
  affected activations, rebuilds subject aggregates, and queues award
  recalculation jobs. Geodata now provides scoped impact and confirmation jobs
  and a retryable worker that applies the Activity cascade before transactionally
  deleting Geodata references and the entity. Both services persist outbox
  events; NATS delivery, explicit redrive, and lease heartbeats remain open.
- Geodata now accepts bounded JSON GeoJSON imports, stores the source document
  in S3-compatible object storage, and creates an idempotent queued import run
  (20 MiB request limit and 5,000 feature default, adjustable with
  `GEODATA_MAX_IMPORT_FEATURES`) with a transactional outbox event. The
  Geodata worker leases queued runs,
  validates feature names and WGS84 geometries, stages candidates with
  provenance and 50 m duplicate warnings, records errors, and emits the
  preprocessing fact. The service also has PostGIS-backed public entity
  list/detail reads with bounded paging, status/category/location filters, and
  bounding-box queries. Pending candidates can be paged, confirmed, or rejected
  through authorized, idempotent review writes. Selected candidates can be
  queued for CANDIDATE or scope-gated APPROVED promotion; the worker writes
  entities, category and source links, audit/outbox events, and per-candidate
  queue outcomes. Entity lifecycle review and If-Match protected name, website,
  and description edits are transactional and audited. If-Match protected
  geometry, category, and manual location edits are also audited. Location
  names are checked against the provider catalogue, provider codes cannot be
  manually set, and location edits require `geodata.location.manage`. An
  authorized, idempotent request can queue BigDataCloud reverse geocoding; the
  Geodata worker applies results only to the matching geometry and protects
  manual fields. Missing metadata now queues enrichment automatically on
  lifecycle promotion; geometry changes queue refreshes, and releasing manual
  fields queues only missing values. Refresh schedules can be created, listed,
  and manually run as complete snapshots. Snapshot runs stage and promote the
  full validated candidate set, record source manifests, and apply configured
  disappearance policies only after successful promotion. Automatic scheduled
  execution remains outstanding.
  Candidate-level failures from a FAILED promotion queue can be resubmitted
  through the promotion API, and failed queues can now be redriven as a whole
  with a recorded reason. NATS delivery remains outstanding. Community proposals now enter
  the same validated import pipeline and automatically queue promotion to the
  CANDIDATE lifecycle state. Tagged load-test cleanup is opt-in, confirmation
  protected, restricted to terminal runs and owned object storage, and refuses
  to remove entities with Activity impact.
  Owner-scoped resumable S3 multipart uploads now support idempotent session
  creation, bounded binary parts, progress reads, completion, checksum and
  malware scanning, abort, and transactional import-run/outbox creation. This
  path currently accepts GeoJSON up to the worker's 20 MiB in-memory limit;
  other legacy import formats and larger streaming imports remain outstanding.
  Durable object references from the configured import bucket are also
  bounded, hash-checked, validated as GeoJSON, and staged in the worker's
  normalized source format.
  Import cancellation is available for queued and active preprocessing runs:
  queued sources are discarded immediately, while workers honor active
  requests at the candidate staging checkpoint and clear temporary source data.
  A worker restart recovers runs left in the CANCELLING state.
  Persisted conflation candidates can be paged by resolution and resolved with
  reviewer history, idempotency, and a transactional outbox fact. Entity import
  promotion now searches overlapping PostGIS bounding boxes, computes the
  baseline name/containment/overlap/distance/jurisdiction score, and stores
  deduplicated candidates at the existing 0.55 threshold.
  The supported import
  adapter catalogue, provider-derived location hierarchy, and authorized
  paged import-run status reads are also exposed. Import finalization now
  discards staged candidates and queues, marks terminal runs processed, and
  records a transactional outbox fact. Authenticated entity audit
  reads combine the entity's review histories with durable audit events. Vector
  tile reads serve approved entity geometry as Mapbox vector tiles.
- Award definitions now support public published-only reads, administrative
  draft create/edit, review submission and decisions, print-readiness
  validation, publication, and retirement. Saved and published facts commit to
  the Activity outbox with their definition updates. Award evaluation and
  historical recalculation jobs use service-owned facts, persist versioned
  progress, and create deduplicated qualification notifications. Participant
  progress reads evaluate and persist the current aggregate snapshot. Award
  assets support registration, owner/admin listing, bounded PNG/JPEG uploads,
  S3-compatible storage, metadata validation, and authenticated content reads.
  Award requests validate published-award eligibility from Activity aggregates,
  deduplicate by award/level/participant, and write request events transactionally.
  Administrator issuance commits the immutable record, request transition, and
  issuance event together. Certificate render jobs create PDF artifacts from
  registered PNG/JPEG artwork in S3-compatible storage; authorized participants
  receive short-lived artifact download URLs.

## Not implemented yet

- Profile-image orphan cleanup and automated compatibility coverage for the
  first Identity slice are still outstanding.
- Remaining Activity operational workflows are outstanding. CSV file import
  validates bounded UTF-8 logs and queues normalized QSO rows for the existing
  ingestion worker. The Gateway now routes public API requests to their owning
  services and protects the Grafana identity callback. Geodata remaining worker
  operations are outstanding.
- The NestJS outbox relay now publishes contract-routed facts and work from one
  configured owner database per process, with stable JetStream message IDs,
  bounded retries, dead-letter persistence, and read-only validation of the
  deployment-owned fact/work streams and registered durable policies. Relay
  metrics are exposed, and registered work payload schemas are validated;
  outage/recovery evidence remains outstanding. Activity
  job redrive is audited and available to
  administrators; the Activity worker now extends active job leases while
  long batches run. Geodata lease heartbeats for large jobs and remaining
  enrichment and retention consumers remain outstanding.
- Admin and Participant web applications.
- Database migration runner, data transfer tooling, deployment images, and
  production observability configuration.
- Email delivery. Its source contract is recorded, but the current Identity
  producer/runtime is gated and its separate database conflicts with the
  requested three-database target until its ownership is resolved.

The Activity notification and email worker entry points remain explicit stubs.
Contract presence and successful builds do not count as function parity. Track
completion against the [parity matrix](parity-matrix.md).
