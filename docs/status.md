# Implementation status

**Baseline reference:** MyOTA monorepo commit
`7f904a5130e59006765cf882956a4adbfecb17ec`.

## In place

- User-selected Node.js/NestJS runtime with Node 24 and NestJS 12.
- GitHub Actions CI runs formatting, lint, typecheck, and all API/worker builds
  on pushes and pull requests using Node 24.
- The lint gate statically checks that every Nest CLI application has one
  distinct `observeRoot` service ID and an instrumented process bootstrap.
- Nest CLI monorepo projects for Gateway, Identity, Programmes, Activity,
  Geodata, and the separate worker process slots.
- Shared `/healthz` liveness and `/readyz` readiness handlers. Identity and
  Programmes probe Core PostgreSQL, Activity probes Activity PostgreSQL, and
  Geodata probes PostGIS. Gateway readiness does not depend on a database.
- The shared HTTP bootstrap honors `MYOTA_MAX_BODY_BYTES` as a strict integer.
  Identity and Programmes default to 1 MiB, Geodata to 1 GiB as in the Python
  reference, and Activity/Gateway to 35 MiB for encoded upload paths. Individual
  import and upload handlers may enforce smaller limits.
- `@nestjs/observe` 0.3.16 is wired through the shared platform package into all
  12 NestJS components (five APIs and seven workers/importer), with a distinct
  service ID for each and automatic instrumentation enabled at bootstrap. Set
  `OBSERVE_APP_KEY` and `OBSERVE_APP_SECRET` to report telemetry; without them,
  the SDK emits no telemetry. `MYOTA_BUILD_VERSION` or `GIT_SHA` labels the
  deployed version when provided.
- A create-only JetStream provisioner consumes the event registry, requires
  explicit apply opt-in and measured finite stream limits, creates missing
  streams/durables, and rejects configuration drift. See
  `deploy/jetstream/README.md` for supported scopes and settings.
- Local Compose now runs the NestJS services against the three owner databases,
  with local JetStream, object storage, SMTP capture, and one-shot migration
  and topology setup. This is a development stack; production release and
  rollout qualification remain open.
- Three-owner database backup and restore commands write custom-format dumps
  with a SHA-256 manifest and verify all files before restore. Cross-version
  data transfer and restore rehearsal remain open.
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
  persisted session, revocation, lockout and rate-limit tables. A separate
  Core-owned maintenance process expires Identity records and removes aged,
  unreferenced profile-image objects. Token, recovery, lockout, and maintenance
  integer settings use the shared strict parser to match Python's environment
  value handling.
- Transactional event helpers write domain events to the Core outbox and
  security events to both the security-event table and outbox.
- Programme listing, detail and effective-policy reads, plus scoped creation,
  update and archive transitions, now load and persist snapshots in Core with
  transactional outbox writes. Creation requires non-empty slug, name, entity
  types, and rules, matching the Python reference. Global entity-type catalogue management and
  per-programme entity-type reads, assignments and removals use the same state
  transaction and outbox boundary. Programme content supports draft editing,
  review submission and decisions, publication, paginated filtering, and locale
  coverage reporting; content values and policy schemas follow the reference's
  non-empty JSON checks. Programme content now uses an indexed Core relational
  table with a migration backfill; content transitions, idempotency records,
  and outbox events commit together. A dedicated read repository serves its
  pages and locale coverage, while policy drafts and programme metadata remain
  in the Core snapshot. Programme policy drafts support scoped authoring,
  submission, review, publishing, and effective policy updates. Effective
  publication timestamps accept Python-compatible basic and extended date and
  time forms, space-separated and comma-fraction input, and compact timezone
  offsets; they reject impossible calendar dates and normalize to UTC with
  microsecond precision.
  Programme content and policy-draft filtering, sorting, counting, and page
  selection, plus locale coverage aggregation, run in Core PostgreSQL; the API
  transfers only the requested page or aggregate into Node.js. A dedicated
  read repository owns these queries separately from the snapshot mutation and
  transactional outbox repository.
- Activity now has an initial API slice for activation listing, creation,
  retrieval, closure, and single-QSO recording. Activation creation enforces
  programme location requirements and configured entity bounds. It persists normalized
  activations and QSOs in Activity PostgreSQL with UTC microsecond timestamp
  precision preserved through normalization, validity checks, persistence,
  deduplication, and reads. It writes domain events and
  idempotency responses transactionally, updates subject aggregates, and
  queues award recalculation work through the Activity outbox. High-volume QSO
  ingestion requests are authorized, bounded, persisted as Activity jobs, and
  exposed through an owner-scoped status API. Bounded UTF-8 CSV logs are
  normalized into those ingestion jobs. The Activity worker consumes the
  registered JetStream work durables and processes jobs transactionally with
  database leases, message progress acknowledgements, bounded retries, and
  dead-letter records. Its `/healthz` and `/readyz` endpoints expose liveness
  and database/NATS readiness on `ACTIVITY_WORKER_HEALTH_PORT`. Public
  activation history masks operator callsigns, leaderboards use subject
  aggregates, and result exports support
  JSON and CSV. QSO correction requests and administrator review now use
  transactional Activity persistence; applying a correction queues award
  recalculation. Activity statistics can be listed and rebuild jobs queued,
  processed into versioned programme/category/entity/jurisdiction snapshots,
  and inspected; recipient notifications can be read with owner/admin checks.
  Activation history, public activation history, and statistics pages now use
  database limits and offsets; public result exports remain complete exports.
  ADIF uploads are ownership-checked, size-limited, scanned, stored in S3, and
  queued transactionally; the Activity worker decodes and normalizes the ADIF
  file before row processing, so parser failures fail the import. Later
  per-record failures are reported alongside persisted QSOs and aggregate
  updates. Timestamp parsing preserves the Python reference's compact ISO date
  and time forms, slash-separated QSO dates with compact times, and hour-only
  UTC offsets; imports with no parsed QSO records retain the reference's
  successful zero-record outcome. Upload-size, QSO-batch, and ADIF retention
  settings use one strict integer parser across Activity API and worker paths,
  consistent with the Python environment settings. Retention intervals retain
  their 60-second minimum.
  Completion notices include the full final import result, matching the Python
  worker's notification payload. Successful imports also recalculate award
  progress for the operator and hunters in successfully persisted or duplicate
  QSOs.
  Scheduled retention removes completed or failed ADIF source objects after the
  configured window and records successful deletion in Activity PostgreSQL.
  A periodic repair loop recreates missing outbox commands for queued Activity
  jobs, including rows preserved from the prior runtime.
  Entity-deletion impact reads and idempotent cascades are implemented: the
  Activity service removes linked valid QSOs and corrections, invalidates
  affected activations, rebuilds subject aggregates, and queues award
  recalculation jobs. Geodata now provides scoped impact and confirmation jobs
  and a retryable worker that applies the Activity cascade before transactionally
  deleting Geodata references and the entity. Both services persist outbox
  events. Geodata deletion now runs through its registered durable and extends
  the owner lease; explicit redrive and outage/recovery evidence remain open.
- Geodata now accepts bounded JSON GeoJSON, WFS GeoJSON, and ArcGIS
  FeatureServer JSON imports; ArcGIS features are normalized to WGS84 GeoJSON
  before storage, and the source format is retained in import metadata. Import
  creation stores the normalized source document in S3-compatible object
  storage and creates an idempotent queued import run (configurable
  `MYOTA_MAX_BODY_BYTES` request limit, 1 GiB default, and 5,000 feature
  default, adjustable with
  `GEODATA_MAX_IMPORT_FEATURES`) with a transactional outbox event. The
  Geodata worker consumes registered preprocessing work and claims the named run,
  normalizes adapter-specific feature fields, source identifiers, and supported
  coordinate reference systems, enforces the reference's 50,000-coordinate
  geometry limit and WGS84 bounds, filters nonmatching OSM tags as skipped
  records, preserves scalar source IDs and scopes legacy manual row-number
  references to their import, hashes each normalized source record separately,
  stages candidates with provenance and 50 m duplicate warnings, records errors,
  and emits preprocessing results with skipped reasons.
  `/healthz` and `/readyz` expose worker liveness and
  GeoData PostgreSQL/NATS readiness on `GEODATA_WORKER_HEALTH_PORT`. The service
  also has PostGIS-backed public entity
  list/detail reads with bounded paging, status/category/location filters, and
  bounding-box queries. The adapter catalogue retains baseline format names
  and aliases, including `PARKSERVE_US` and `SHP`, and lists Shapefile support
  for manual imports. Pending candidates can be paged, confirmed, or rejected
  through authorized, idempotent review writes. Selected candidates can be
  queued for CANDIDATE or role-scoped APPROVED promotion; the worker writes
  entities, category and source links, audit/outbox events, and per-candidate
  queue outcomes. Entity lifecycle review and If-Match protected name, website,
  and description edits are transactional and audited. If-Match protected
  geometry, category, and manual location edits are also audited. Location
  names are checked against the provider catalogue, provider codes cannot be
  manually set, and location edits require GIS administrator coverage or
  `geodata.location.manage`. Review writes require role coverage for the
  entity's programme, category, and jurisdiction. Entity
  category updates accept scalar codes and category objects, remove duplicate
  codes while preserving order, and keep the first code primary. An authorized,
  idempotent request can queue BigDataCloud reverse geocoding; the
  provider-derived location hierarchy sorts case-insensitively with codes as
  tie-breakers. The
  Geodata worker applies results only to the matching geometry and protects
  manual fields. Missing metadata now queues enrichment automatically on
  lifecycle promotion; geometry changes queue refreshes, and releasing manual
  fields queues only missing values. Refresh schedules can be created, listed,
  and manually run as complete snapshots. The Admin supports schedule creation,
  paging, and manual GeoJSON snapshot runs. Snapshot runs stage and promote the
  full validated candidate set, record source manifests, and apply configured
  disappearance policies only after successful promotion. The opt-in
  allowlisted importer now executes due schedules through the Geodata API;
  deployment and live-source qualification remain outstanding.
  Candidate-level failures from a FAILED promotion queue can be resubmitted
  through the promotion API, and failed queues can now be redriven as a whole
  with a recorded reason. Community proposals now enter
  the same validated import pipeline and automatically queue promotion to the
  CANDIDATE lifecycle state. Tagged load-test cleanup is opt-in, confirmation
  protected, restricted to terminal runs and owned object storage, and refuses
  to remove entities with Activity impact.
  Owner-scoped resumable S3 multipart uploads now support idempotent session
  creation, bounded binary parts, progress reads, completion, checksum and
  malware scanning, abort, and transactional import-run/outbox creation. This
  path streams GeoJSON sources and decoded features; its upload default is 256
  MiB and can be raised to 512 MiB with `MYOTA_GEOJSON_MAX_UPLOAD_BYTES`.
  Shapefile ZIP uploads stream to temporary disk, then decode one shape/DBF
  record at a time. Their default upload cap is 256 MiB and can be raised to
  512 MiB with `MYOTA_SHAPEFILE_MAX_UPLOAD_BYTES`; archives are capped at 100
  members and 1 GiB expanded. Matching .shp, .shx, and .dbf sidecars are
  required.
  Pasted-import creation also decodes bounded KML and GPX to GeoJSON. OSM PBF
  uploads now decode in the Geodata worker with osmium-tool. The converter
  preserves OSM tags and stable type/id source references, filters the current
  hiking-path and protected-area tag catalogue, and assembles closed-way and
  multipolygon areas using a temporary disk-backed node-location index. PBF
  source bytes stream to disk with checksum verification; the upload default
  is 256 MiB and can be raised to 512 MiB with
  `MYOTA_OSM_PBF_MAX_UPLOAD_BYTES`. Decoded output is capped at 128 MiB, with
  16 MiB and 250,000 vertices per feature, plus the configured feature cap.
  GeoJSON and Shapefile upload parsing enforce 16 MiB and 250,000 vertices per
  feature. Prepared candidates and validation errors are attempt-scoped in the
  Geodata database; per-record hashes and source manifests are persisted
  alongside final candidate creation, queue creation, status, and outbox events
  in one transaction. The final event is assembled in PostgreSQL to avoid
  retaining every feature summary in the worker heap.
  Direct JSON imports and durable source-object references honor the configured
  body and upload limits. The direct JSON import path still materializes the
  normalized collection; multipart GeoJSON remains the streaming path. Shapefile
  source bytes and decoded
  records now stream via bounded temporary files, matching the reference's 1
  GiB expanded-size default and reproject coordinates using `.prj` metadata.
  The streaming parser's less common geometry types and uncommon CRS
  definitions still need parity qualification before broad Shapefile parity can
  be claimed.
  The adapter catalogue and admin selector now expose only import formats the
  current boundary can decode. The admin file picker accepts GeoJSON and OSM
  PBF and Shapefile ZIP files up to their configured caps (256 MiB by default,
  512 MiB maximum).
  Durable object references from the configured import bucket are also
  bounded, hash-checked, validated as GeoJSON, and staged in the worker's
  normalized source format.
  Import cancellation is available for queued and active preprocessing runs:
  queued sources are discarded immediately, while workers honor active
  requests at the candidate staging checkpoint and clear temporary source data.
  A worker restart recovers runs left in the CANCELLING state.
  Persisted conflation candidates can be paged by resolution and resolved with
  reviewer history, idempotency, and a transactional outbox fact. The Admin
  includes a role-gated conflation workspace for filtering candidates, inspecting
  match signals and prior decisions, and recording resolutions. Entity import
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
  A separate scheduled importer can poll due refresh schedules and fetch
  GeoJSON or ArcGIS FeatureServer data from explicitly allowlisted HTTPS hosts.
  It remains disabled unless `GEODATA_IMPORTER_ENABLED=true`; deployment and
  live-source qualification remain outstanding.
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
  receive short-lived artifact download URLs. Admins can render an unsaved
  certificate preview with bounded print settings, mock participant data, and
  registered artwork; preview PDFs are returned in memory without creating an
  issuance or object. The API and render worker share one PDF renderer.
- The Activity notification worker validates and consumes the registered
  JetStream durable, inserts recipient notices with event deduplication and
  consumer checkpoints in one Activity database transaction, retries transient
  failures, and stores redacted poison envelopes with stream coordinates before
  terminating them. Its metrics listener exposes `/healthz`, `/readyz`, and
  Prometheus metrics for bounded delivery outcomes and unresolved dead letters;
  readiness checks Activity PostgreSQL and the NATS connection. An audited CLI
  redrive reuses pending audit records and a stable JetStream message ID. Worker
  recovery evidence remains outstanding.

## Not implemented yet

- Automated compatibility coverage for the first Identity slice remains
  outstanding.
- Remaining Activity parity and recovery evidence are outstanding. The
  Gateway routes public API requests to their owning services and protects the
  Grafana identity callback. Geodata import
  preprocessing, promotion, deletion, and enrichment now consume registered
  JetStream durables and claim the referenced owner-database job. A periodic
  reconciler republishes stale queued work and expired leases transactionally
  through the outbox. Scheduled retention removes finalized or inactive import
  history and owned source objects, expires stale multipart uploads, and keeps
  materialized entities; outage/recovery evidence remains outstanding.
- The NestJS outbox relay now publishes contract-routed facts and work from one
  configured owner database per process, with stable JetStream message IDs,
  bounded retries, dead-letter persistence, and read-only validation of the
  deployment-owned fact/work streams and registered durable policies. Relay
  metrics are exposed, and registered work payload schemas are validated.
  `/healthz` reports liveness and `/readyz` reflects database and NATS status;
  outage/recovery evidence remains outstanding. Activity
  job redrive is audited and available to
  administrators; the Activity worker now extends active job leases while
  long batches run and repairs missing queued-job outbox commands. Geodata import, promotion, and deletion work extends owner
  leases during long jobs, and stale dispatch recovery and Geodata retention are
  implemented; outage/recovery evidence remains outstanding.
- Baseline Admin Vue application and static Participant application now live
  under `web/` as separate deployable artifacts. Admin local checks/build are
  part of CI. A static source scan resolves 62 concrete Admin HTTP method/path
  pairs, all present in the OpenAPI contract. This does not establish payload
  or workflow parity; visual/accessibility review and deployment integration
  also remain open.
- Data transfer tooling, image publication, deployment manifests, and
  production observability configuration. A reusable Docker recipe now builds
  one unprivileged runtime image per Nest application. An owner-scoped database
  migration runner applies the checked-in SQL baseline and forward migrations
  with checksums and per-file transactions; production cutover and rollback
  rehearsals remain outstanding.
- Email delivery. The NestJS consumer now validates `email.send.v1`, resolves
  recipients through Identity, sends through TLS-configured SMTP, and records
  deduplication, attempts, and redacted dead letters in the Core database. The
  former fourth email database is removed from the target. Identity production,
  OpenTelemetry export, and deployment integration remain outstanding. The
  worker exposes `/healthz`, `/readyz`, and Prometheus metrics. An audited
  redrive CLI resets one dead-letter record and records the operator's reason
  before the original command is replayed from its producer outbox.

Email delivery is not end-to-end qualified. Contract presence and successful
builds do not count as function parity. Track completion against the
[parity matrix](parity-matrix.md).
