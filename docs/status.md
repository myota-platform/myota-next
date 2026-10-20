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
- Shared query parsing selects the first nonblank repeated string value for
  Activity activation/public/statistics/notification filters, award filters,
  Identity admin filters, Programme content and policy filters, public content
  locale, and Geodata filters. Award progress also accepts the reference's
  `subjectId` alias for `participantId`. Pagination skips blank repeated values
  before parsing `page` and `pageSize`, and accepts Python's numeric whitespace
  and Unicode decimal digits for those integer values. The page-size cap is
  applied before converting to a JavaScript number, so oversized valid page
  sizes are clamped to 100 as in the reference.
- The shared HTTP bootstrap honors `MYOTA_MAX_BODY_BYTES` as a strict integer.
  Identity and Programmes default to 1 MiB, Geodata to 1 GiB as in the Python
  reference, and Activity/Gateway to 35 MiB for encoded upload paths. Individual
  import and upload handlers may enforce smaller limits.
- NestJS HTTP APIs return a shared problem response for framework exceptions,
  malformed JSON, and Gateway-generated route/upstream errors. Each request
  receives validated or generated request and correlation IDs in response
  headers and in the problem body. The OpenAPI contract defines the `Problem`
  schema. Authentication failures and login rate limits use the reference
  service's 400/403 status behavior.
- `@nestjs/observe` 0.3.16 is wired through the shared platform package into all
  12 NestJS components (five APIs and seven workers/importer), with a distinct
  service ID for each: `gateway`, `identity-api`, `programmes-api`,
  `activity-api`, `geodata-api`, `identity-maintenance`, `activity-worker`,
  `activity-notifications`, `geodata-worker`, `geodata-importer`, `email-worker`,
  and `outbox-worker`. Automatic instrumentation is enabled at bootstrap. Set
  `OBSERVE_APP_KEY` and `OBSERVE_APP_SECRET` to report telemetry; without them,
  the SDK emits no telemetry. `MYOTA_BUILD_VERSION` or `GIT_SHA` labels the
  deployed version when provided.
- The shared HTTP bootstrap records Prometheus request counters labeled by
  service, method, route template, and status for all five API processes. Their
  `/metrics` endpoints remain outside the `/v1` API prefix.
- Geodata exposes a Prometheus `/metrics` endpoint with PostGIS tile-query
  duration and slow-query metrics. The `MYOTA_SLOW_QUERY_THRESHOLD_MS` setting
  defaults to 250 ms, matching the Python reference. The legacy `entity_upsert`
  series measured full-snapshot synchronization and is not emitted by the
  row-authoritative write paths.
- ADIF QSO imports normalize and validate records before inserting valid rows in
  one PostgreSQL batch. If a database value rejects that batch, the worker falls
  back to per-record inserts so valid records still import and errors retain
  their record numbers.
- Programme records, content, policy drafts, and entity-type catalogue now use
  Core relational tables. Programme mutations now use the shared transaction
  repository and outbox without persisting duplicate event history in a JSONB
  snapshot; runtime adoption of the new migrations remains a separate gate.
- A create-only JetStream provisioner consumes the event registry, requires
  explicit apply opt-in and measured finite stream limits, creates missing
  streams/durables, and rejects configuration drift. See
  `deploy/jetstream/README.md` for supported scopes and settings.
- Local Compose now runs the NestJS services against the three owner databases,
  with local JetStream, object storage, SMTP capture, and one-shot migration
  and topology setup. This is a development stack; production release and
  rollout qualification remain open.
- Activity PostgreSQL pools honor `MYOTA_ACTIVITY_DB_POOL_MAX` before the shared
  `MYOTA_DB_POOL_MAX`, with a default maximum of 12 connections. Core and
  Geodata pools use the shared setting and default to 10; every pool keeps a
  minimum size of one.
- Three-owner database backup and restore commands write custom-format dumps
  with a SHA-256 manifest, require distinct PostgreSQL targets for Core,
  Activity, and Geodata, and verify all files before restore. Cross-version
  data transfer and restore rehearsal remain open. See
  [database backup and restore](operations/database-backup-restore.md).
- Current OpenAPI, event schemas, and three database migration baselines copied
  as compatibility references.
- First Identity slice: disabled public registration, password login, refresh
  rotation, logout revocation, recovery request/reset, current account and
  scope reads, owner-only profile updates, and paginated administrator account
  listing, account creation, role-catalogue reads, role creation, and role
  updates, account reads and active role reads for the account owner or global
  operator, and administrative account updates including profile, credentials,
  lifecycle, anonymization and role replacement. Anonymizing an account clears
  its profile-image reference transactionally and immediately attempts object
  deletion; the maintenance orphan sweep remains the fallback. Callsign add, primary
  selection, evidence submission, verification, and retirement, plus paginated
  security-event reads for global administrators and owner-scoped account data
  export, scoped OIDC provider mapping registration, and five-minute service token
  issuance with the restricted email-recipient lookup, and normalized private
  profile-image upload/read/delete are also implemented. Email-service token
  authentication compares UTF-8 secret bytes in constant time and requires at
  least 32 configured secret characters; caller-issued service tokens require a
  non-empty scope list before authorization, matching the Python handler.
  Account creation uses the reference's non-empty email and `@` validation
  after Python-compatible trimming and case folding. It authorizes the
  administrator before validating the payload and normalizes callsign
  whitespace like the Python handler. Idempotent replays and duplicate-email
  failures precede the extra role-assignment authorization, matching the
  reference order. Optional administrative role fields are applied only when
  supplied; explicit `null` is rejected for fields the API schema defines as
  non-null.
  Login and recovery accept any non-empty email string and resolve it through
  the normalized Identity email key, matching the Python handler.
  Callsign source, evidence metadata, verification source, and retirement
  `validTo` preserve explicitly submitted `null` values where the Python
  handler does. Callsign status remains a non-null enum as required by the Core
  schema; explicit `null` is rejected instead of defaulted to `UNVERIFIED`.
  Website URL validation rejects embedded Unicode whitespace using Python's
  `str.isspace()` set, including U+0085.
  Recovery responses expose the development reset token unless `MYOTA_ENV` is
  exactly `production`, matching the reference's case-sensitive check.
  Recovery reset checks token validity before enforcing the 12-character
  password minimum, matching the reference validation order.
  Logout ignores invalid refresh tokens but validates any supplied bearer token
  and accepts access or service tokens for revocation, matching the reference.
  The Core migration removes the retired `operations.read` scope from persisted
  custom role definitions and advances their update timestamp, matching the
  reference when it materializes the role catalogue.
  Authentication uses the existing scrypt hash format, HS256 token contract,
  persisted session, revocation, lockout and rate-limit tables. A separate
  Core-owned maintenance process expires Identity records and removes aged,
  unreferenced profile-image objects; it honors zero-second intervals and
  rejects negative intervals after its initial sweep, matching Python's loop.
  Database cleanup failures terminate the worker; profile-image cleanup
  failures are logged and retried on the next sweep. Rate-limit rows are
  retained until their window has strictly passed, matching the reference.
  Profile-image orphan cleanup follows the reference's three-segment key shape
  without requiring UUID-formatted path segments.
  Token, recovery, lockout, and maintenance
  integer settings use the shared strict parser with Python numeric whitespace
  and Unicode decimal digits. The Gateway also forwards User-Agent so Identity session
  metadata matches direct request context. Unicode 15.0 case-fold mappings in
  Core now provide indexed email identity keys for login, recovery, account creation, and email updates;
  email normalization uses Python's Unicode whitespace stripping rules before
  case folding. Callsign and administrative role cleanup use the same Python
  whitespace rules. Migration rejects case-fold-equivalent duplicate addresses
  before building the unique index. The Gateway overwrites and signs the client socket address;
  Identity verifies it before using it for login rate limits and security-event
  audit metadata.
  Identity startup also creates the configured bootstrap
  administrator idempotently, fills only a missing password, ensures the
  `GLOBAL_OPERATOR` role, and writes the account and bootstrap facts to Core.
- Transactional event helpers write domain events to the Core outbox and
  security events to both the security-event table and outbox.
- Programme records now live in a Core relational table migrated from the
  Programme snapshot. Listing, detail, effective-policy reads, and scoped
  creation, update, and archive transitions use the relational records with
  transactional outbox writes. Creation requires non-empty slug, name, entity
  types, and rules, matching the Python reference. Global entity-type catalogue
  management uses its own Core table; assignments are persisted in the
  relational Programme record and commit with catalogue and outbox changes.
  Programme creation preserves explicit null descriptions and themes while
  applying defaults only when those fields are omitted. `policyVersion` uses
  Python integer conversion, including arbitrary-precision JSON integers, and
  is not constrained to positive values.
  Entity-type code, geometry, label, and description cleanup use Python's
  Unicode whitespace stripping rules.
  Programme content supports draft editing,
  review submission and decisions, publication, paginated filtering, and locale
  coverage reporting with Python-compatible half-to-even percentage rounding;
  content creation reuses a truthy supplied string ID, generates a UUID for an
  omitted or empty ID, and accepts those IDs on lifecycle routes, matching the
  reference handler;
  content values and policy schemas follow the reference's
  non-empty JSON checks. Programme content now uses an indexed Core relational
  table with a migration backfill; content transitions, idempotency records,
  and outbox events commit together. Policy drafts now use a separate indexed
  Core table; draft creation retains truthy supplied string IDs, generates a
  UUID for omitted or empty IDs, and accepts those IDs on lifecycle routes.
  Optional DTO fields on account, Programme-content, policy-draft, and shared
  entity-type updates distinguish omission from explicit `null`; omitted
  fields retain stored values, while null follows the reference-compatible
  validation or clearing behavior.
  Falsey optional effective dates normalize to null on draft save and patch,
  matching the Python handler; falsey optional status values on content and
  policy PATCH requests remain ordinary draft edits. Draft lifecycle writes
  and outbox events are atomic, and policy
  publication remains atomic with the Programme record update. A dedicated
  read repository serves content pages, policy pages, and locale coverage;
  Programme metadata and policy-effective state are carried in relational
  Programme records.
  Programme policy drafts support scoped authoring,
  submission, review, publishing, and effective policy updates. Effective
  publication timestamps accept Python-compatible calendar and ISO week dates,
  basic and extended date and time forms, arbitrary single-character date/time
  separators, comma-fraction input, and timezone offsets with seconds and
  fractional seconds; invalid dates, clock fields, and offsets are rejected,
  and values normalize to UTC with microsecond precision.
  Programme content and policy-draft filtering, sorting, counting, and page
  selection, plus locale coverage aggregation, run in Core PostgreSQL; the API
  transfers only the requested page or aggregate into Node.js. A dedicated
  read repository owns these queries separately from the snapshot mutation and
  transactional outbox repository.
- Activity now has an initial API slice for activation listing, creation,
  retrieval, closure, and single-QSO recording. Activation listing preserves
  reference access semantics: `activity.read` can list activations across
  operators and the optional `operatorId` filter is honored. Activation
  creation enforces programme location requirements and configured entity bounds. An explicit
  `validityDays` value takes precedence over the programme rule, including null,
  and non-empty values use Python-compatible float parsing, including Python's
  numeric whitespace and Unicode decimal digit handling. Activation payload
  `requireLocation` and `allowUnverifiedCallsign` flags use Python truthiness.
  Activation operator callsigns normalize only when truthy, preserving falsey
  values as in Python. Payload normalization and required-field checks precede
  operator authorization, as in the reference. Falsey `location` and `rules`
  alias values normalize to empty
  objects as in Python; rule evaluation also defaults falsey persisted rules to
  an empty object. `authorizedCallsigns` defaults only when omitted and uses
  Python-compatible iteration. It persists
  normalized activations and QSOs in Activity PostgreSQL with UTC microsecond
  timestamp precision preserved through normalization, validity checks,
  persistence, deduplication, and reads. QSO `source` defaults to `manual` only
  when absent; optional `sourceImportId` provenance is retained on direct and
  worker inserts. Activation `allowedBands` and `allowedModes` default only
  when omitted and preserve Python iterable behavior and null/boolean string
  conversion.
  QSO callsigns collapse Python's Unicode whitespace set before validation.
  Worked locator keys use Python's truthiness and Unicode whitespace stripping
  rules; QSO deduplication keys use Python truthiness and scalar conversion for
  optional hunter and entity IDs. QSO timestamps use Python truthiness when
  falling back from `timestamp` to `timeOn`. Activation close defaults
  `endedAt` to now only when omitted;
  supplied values are validated as timestamps. Default
  rule-evaluation times use the same
  six-digit UTC timestamp form as the reference. Minimum QSO
  thresholds use Python integer conversion with matching numeric whitespace
  and Unicode decimal digit handling. It writes domain
  events and idempotency responses transactionally, updates subject aggregates,
  and queues award recalculation work through the Activity outbox. High-volume QSO
  ingestion requests are authorized, bounded, persisted as Activity jobs, and
  exposed through an owner-scoped status API. Bounded UTF-8 CSV logs are
  normalized into those ingestion jobs. The Activity worker consumes the
  registered JetStream work durables concurrently up to each durable's
  `max_ack_pending` limit, and processes jobs transactionally with database
  leases, message progress acknowledgements, bounded retries, and
  dead-letter records. Failed progress acknowledgements are logged while the
  database lease protects the active job from duplicate execution. Work IDs
  accept canonical UUIDs with any version and
  variant bits, and `causationId` remains optional as in the reference and
  shared contract. QSO ingestion batches use one JSONB recordset insert,
  database deduplication, per-record outbox events, and first-record keyed award
  recalculation, matching the reference batch path. Its `/healthz` and `/readyz` endpoints expose liveness
  and database/NATS readiness on `ACTIVITY_WORKER_HEALTH_PORT`. Public
  activation history normalizes and masks operator callsigns, leaderboards use subject
  aggregates, and result exports support
  JSON and CSV. QSO correction requests and administrator review now use
  transactional Activity persistence; required fields use Python truthiness,
  so empty arrays and objects are treated as missing and field validation
  precedes authentication where the reference does. Correction review checks
  required fields before authorization and validates the decision afterward,
  matching the reference's error order. QSO and close operations
  load the activation before operator authorization. QSO ingestion also checks
  record-array shape and batch size after activation authorization.
  QSO ingestion defaults `sourceFormat` only when omitted and preserves an
  explicitly supplied value through job processing, matching the Python
  handler's `body.get` behavior.
  Activation resource updates require `status=CLOSED`, including when the
  request body is empty or null, matching the Python transition handler.
  Activation close ignores `Idempotency-Key`, matching the reference: a repeat
  close is rejected after the first transition rather than replaying a cached
  response.
  Falsey explicit `endedAt` values close with a null end timestamp, matching
  the Python evaluation and database conversion behavior.
  Activation validity defaults use only the submitted `programmeRules` field,
  matching the reference even when validation uses the `rules` alias.
  Statistics rebuild requests always use the reference's programme-and-UTC-day
  idempotency key; a caller-supplied header does not override it.
  Requests store any
  truthy `proposedValues` JSON shape accepted by the reference, rely on the
  database relation to validate the QSO, and ignore `Idempotency-Key` on both
  request and review. Review resolves the QSO through the correction record,
  as the reference does. Applying an object correction queues
  award recalculation, and correction timestamps retain Python-compatible
  falsey-value handling and microsecond precision. Activity statistics can be
  listed and rebuild jobs queued,
  processed into versioned programme/category/entity/jurisdiction snapshots,
  and inspected; recipient notifications can be read with owner/admin checks.
  Activation history, public activation history, and statistics pages now use
  database limits and offsets; public result exports remain complete exports.
  ADIF required fields use Python truthiness before activation lookup and
  authorization. Uploads are ownership-checked, size-limited, scanned, stored in S3, and
  queued transactionally; the submitted filename is preserved in metadata and
  `/` is replaced with `_` only in its object key, matching Python. ADIF import
  creation also ignores `Idempotency-Key`; each accepted upload creates a
  distinct import. The worker decodes and normalizes the ADIF
  file before row processing, so parser failures fail the import. Later
  ADIF field lengths count Unicode code points and accept Unicode decimal digits,
  matching the Python parser. Per-record failures are reported alongside persisted QSOs and aggregate
  updates. An out-of-window QSO aborts the batch without writing rows, and the
  work job retries and dead-letters while the import remains `PROCESSING`, as
  in the Python reference. Timestamp parsing preserves the Python reference's ISO week dates,
  one-character date/time separators, compact ISO date and time forms,
  slash-separated QSO dates with compact times, and UTC offsets with hours,
  minutes, seconds, or fractional seconds. Lowercase `t` separators are
  accepted while lowercase `z` UTC suffixes are rejected, matching Python 3.12.
  UTC offset conversion rejects results outside Python's year 1–9999 range.
  Impossible calendar dates and clock fields
  are rejected;
  imports with no parsed QSO records retain the reference's
  successful zero-record outcome. Upload-size, QSO-batch, and ADIF retention
  settings use one strict integer parser across Activity API and worker paths,
  including Python numeric whitespace and Unicode decimal digits. Retention intervals retain
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
  recalculation jobs. The cascade validates a missing/falsey `entityId` before
  admin authorization, matching the reference route. Geodata now provides scoped impact and confirmation jobs
  and a retryable worker that applies the Activity cascade before transactionally
  deleting Geodata references and the entity. Both services persist outbox
  events. Geodata deletion now runs through its registered durable and extends
  the owner lease; explicit redrive and outage/recovery evidence remain open.
- Geodata now accepts bounded JSON GeoJSON, WFS GeoJSON, and ArcGIS
  FeatureServer JSON imports; ArcGIS WKIDs are normalized to WGS84 GeoJSON
  before storage using the built-in Web Mercator aliases or an installed
  `proj4` definition, and the source format is retained in import metadata.
  Web Mercator latitude conversion reports positive exponential overflow rather
  than accepting a clamped 90-degree latitude, matching Python.
  Import
  creation stores the normalized source document in S3-compatible object
  storage and creates an idempotent queued import run (configurable
  `MYOTA_MAX_BODY_BYTES` request limit, 1 GiB default, and 5,000 feature
  default, adjustable with `GEODATA_MAX_IMPORT_FEATURES`, shared by the API,
  worker, and scheduled importer) with a transactional outbox event. The
  Geodata worker consumes registered preprocessing work and claims the named run,
  normalizes adapter-specific feature fields, source identifiers, and supported
  coordinate reference systems, enforces the reference's 50,000-coordinate
  geometry limit and WGS84 bounds. CRS reprojection emits XY coordinates,
  matching the Python transformer input; WGS84 input retains any extra
  coordinate ordinates. It filters nonmatching OSM tags as skipped
  records, preserves scalar source IDs and scopes legacy manual row-number
  references to their import, hashes each normalized source record separately,
  stages candidates with provenance and 50 m duplicate warnings, records errors,
  and emits preprocessing results with skipped reasons. Community proposal
  promotion preserves the reference `candidateSource` shape and derives
  `sourceRef` through the ordinary import fallback. Import source identity now
  selects `sourceKey`, `url`, then `name` with Python truthiness and preserves
  submitted whitespace; source metadata keeps the caller's values plus the
  reference name/license defaults. Proposal feature objects pass through the
  same adapter normalization without an extra `type` requirement. Proposal and
  direct-import idempotency is scoped to owner and actual request path and
  rejects reuse with a changed body before validation. Fingerprints preserve
  JSON integer versus float values, and the request lock spans validation,
  source storage, and import/outbox creation. Candidate validation and
  promotion now follow the same owner/path/body request contract and replay
  before body validation. Entity review, metadata, category, geometry, and
  location-enrichment writes follow the same contract. Conflation resolution
  uses the same request contract and retains transactional history and outbox
  writes. Refresh schedule creation also scopes idempotency by owner and path
  and rejects changed-body reuse before validation. Manual schedule runs use
  the same request contract and replay the prior import/schedule response.
  Deletion-job creation and confirmation also replay by owner, path, and body,
  including confirmation retries after job completion. Import finalization
  and failed promotion queue redrive follow the same request fingerprint and
  replay contract.
  `/healthz` and `/readyz` expose worker liveness and
  GeoData PostgreSQL/NATS readiness on `GEODATA_WORKER_HEALTH_PORT`. The service
  also has PostGIS-backed public entity
  list/detail reads with bounded paging, status/category/location filters, and
  bounding-box queries whose coordinate parsing follows Python float syntax,
  including Unicode decimal digits and numeric underscores. Catalogue filters
  and conflation resolution select the first nonblank repeated value;
  catalogue text filters are case-insensitive, while resolution is
  case-sensitive. Repeated status filters combine values.
  The adapter catalogue retains baseline format names
  and aliases, including `PARKSERVE_US` and `SHP`, and lists Shapefile support
  for manual imports. Feature-name alias matching uses Python-compatible Unicode
  casefolding, whitespace collapse, and 300-code-point truncation. Pending
  candidates can be paged, confirmed, or rejected
  through authorized, idempotent review writes. Candidate validation checks
  required fields first and preserves duplicate IDs in submitted order, matching
  the Python handler. Validation status coercion applies Python truthiness and
  string conversion before checking supported values. Selected candidates can be
  queued for CANDIDATE or role-scoped APPROVED promotion. Promotion validates
  required fields in reference order; selection sorts and deduplicates candidate
  IDs and has no extra 500-ID cap, matching the Python handler. The worker writes
  entities, category and source links, audit/outbox events, and per-candidate
  queue outcomes. Entity review, metadata, category, and geometry changes
  preserve submitted note JSON values without type coercion or truncation, as
  the Python handlers do, and
  If-Match protected name, website, and description edits are transactional and
  audited. If-Match protected geometry, category, and manual location edits are
  also audited. Geometry
  updates accept Python's `way`, `linestring`, and `multilinestring` aliases
  and persist their canonical type with only type and coordinates. API edits
  and import workers share Python's structural validation and configured
  coordinate limit; edits enforce WGS84 bounds without an additional
  topology-validity rejection. Category
  codes use Python's Unicode whitespace stripping rules, and category edit
  history records both the primary-code aliases and full category lists.
  Relational category assignments preserve caller order across promotion,
  category edits, and entity reads.
  Location
  names, entity names, location values, websites, and descriptions now use
  Python whitespace stripping and code-point length rules; manual boolean and
  non-integral numeric values use Python string forms. Metadata patches
  apply `manualFields` only alongside a location object; omission defaults to
  the location keys, while explicit null is rejected as a non-list value.
  Website validation rejects credential syntax even when the username is empty.
  Entity, import, conflation, and
  deletion audit actor IDs retain submitted values without trimming; import
  finalization defaults to `administrator` when no actor is supplied. Location
  names are checked against the provider catalogue. Continent, country,
  region, subdivision, and province codes are provider-derived; `countyCode`
  remains manually editable as in the reference. Location edits require GIS
  administrator coverage or `geodata.location.manage`. Review writes require
  role coverage for the entity's programme, category, and jurisdiction. Review
  status falls back from `status` to legacy `decision` using Python truthiness.
  Entity category updates accept scalar codes and category objects, remove
  duplicate codes while preserving order, and keep the first code primary. An
  authorized, idempotent request can queue BigDataCloud reverse geocoding; the
  provider-derived location hierarchy uses Python Unicode case folding for
  matching, deduplication, and sorting, with codes as tie-breakers. The
  Geodata worker applies results only to the matching geometry and protects
  manual fields. Missing metadata now queues enrichment automatically on
  lifecycle promotion; geometry changes queue refreshes, and geometry edit
  requests always append history and emit an update event, even when geometry is
  unchanged. Location update requests also append history, refresh provenance,
  and emit an update event when submitted values are unchanged. Releasing manual
  fields queues only missing values. Refresh schedules can be created, listed,
  and manually run as complete snapshots. The Admin supports schedule creation,
  paging, and manual GeoJSON snapshot runs. Snapshot runs stage and promote the
  full validated candidate set, record source manifests, and apply configured
  disappearance policies after successful preprocessing. Ordinary imports also
  accept complete snapshots and apply disappearance policy at that stage. The opt-in
  allowlisted importer now executes due schedules through the Geodata API;
  schedule runs preserve the reference timestamp updates, while the importer
  uses `lastRunAt + intervalSeconds` to determine the next automatic run. It
  reads the complete allowlisted response and shares the configured feature cap
  with the API and worker, matching the reference fetch and import limits. It
  also accepts `GEODATA_IMPORT_SPEC` for one-shot complete snapshots and writes
  the resulting import response as JSON to stdout.
  Deployment and live-source qualification remain outstanding.
  Candidate-level failures from a FAILED promotion queue can be resubmitted
  through the promotion API, and failed queues can now be redriven as a whole
  with a recorded reason. Community proposals now enter
  the same validated import pipeline and automatically queue promotion to the
  CANDIDATE lifecycle state. Imports, proposals, refresh schedules, and
  resumable upload sessions use the reference category normalizer: alias truthy
  fallback, category objects, trimming, uppercase codes, invalid-entry
  filtering, and duplicate removal. Upload part numbers and expected sizes use
  Python-compatible integer parsing, including Unicode decimal digits and
  underscores; sizes also preserve boolean and finite-float `int()` conversion
  before the configured byte limits are applied.
  Tagged load-test cleanup is opt-in, confirmation
  protected, restricted to terminal runs and owned object storage, and refuses
  to remove entities with Activity impact. Direct and scheduled imports preserve
  exact adapter values and programme slugs; import formats are uppercased
  without trimming, matching Python input handling.
  `GEODATA_MAX_IMPORT_FEATURES` uses the shared Python-compatible integer
  setting parser in both the API and worker, retaining zero and negative
  configured limits and rejecting malformed values instead of silently using
  the default.
  Owner-scoped resumable S3 multipart uploads now support idempotent session
  creation, bounded binary parts, progress reads, completion, checksum and
  malware scanning, abort, and transactional import-run/outbox creation.
  API admission and worker decoding now share the same 1 GiB default and
  format-specific upload caps, so accepted upload sizes are processable by the
  corresponding worker.
  Upload adapter values are matched exactly, format values are uppercased
  without trimming, filenames preserve submitted whitespace, and idempotency
  keys remain unmodified. Upload size defaults to 1 GiB through
  `MYOTA_UPLOAD_MAX_BYTES`; optional format-specific settings can override that
  value. This path streams GeoJSON sources and decoded features.
  Shapefile ZIP uploads stream to the configured `MYOTA_UPLOAD_SPOOL_DIR`
  (OS temporary directory by default), then decode one shape/DBF
  record at a time, selecting the first `.shp` entry and its matching `.shx`
  and `.dbf` files as the reference does. Deleted DBF rows are filtered before
  shape and record pairing, with iteration bounded by the SHX and active DBF
  row counts to match PyShp. Shapefile upload size follows
  `MYOTA_SHAPEFILE_MAX_UPLOAD_BYTES` or the shared upload limit; archives are capped at 100
  members and the configured expanded-size limit (1 GiB by default).
  `MYOTA_IMPORT_MAX_SHAPEFILE_EXPANDED_BYTES` follows Python integer parsing.
  Matching .shp, .shx, and .dbf sidecars are
  required; DBF text uses PyShp's UTF-8 default and `.cpg` files are ignored,
  matching the reference loader.
  Pasted-import creation also decodes bounded KML and GPX to GeoJSON, applying
  the shared decoded-feature limit and the configured vertex ceiling per
  emitted geometry or GPX track segment (`MYOTA_IMPORT_MAX_FEATURE_VERTICES`,
  250,000 by default).
  OSM PBF
  uploads now decode in the Geodata worker with osmium-tool. The converter
  preserves OSM tags and stable type/id source references, filters the current
  hiking-path and protected-area tag catalogue, and assembles closed-way and
  multipolygon areas using a temporary disk-backed node-location index. PBF
  source bytes stream to the configured upload spool with checksum verification; upload size follows
  `MYOTA_OSM_PBF_MAX_UPLOAD_BYTES` or the shared upload limit. Output streams
  one feature at a time under the per-feature and total-feature limits, into
  staged batches bounded by
  `MYOTA_IMPORT_BATCH_SIZE` and `MYOTA_IMPORT_BATCH_BYTES` (100 features and
  32 MiB by default), with 16 MiB and the configured vertex ceiling per
  feature, plus the configured feature cap.
  GeoJSON, KML, GPX, Shapefile, and PBF parsing use the shared
  `MYOTA_IMPORT_MAX_FEATURE_BYTES` decoded-size limit (16 MiB by default) and
  enforce `MYOTA_IMPORT_MAX_FEATURE_VERTICES` (250,000 by default) through the
  Python-compatible integer parser. Prepared candidates and validation errors are attempt-scoped in the
  Geodata database; per-record hashes and source manifests use Python float
  formatting and Unicode code-point key ordering. Streamed GeoJSON features
  and direct GEOJSON/WFS JSON imports retain raw numeric tokens so `1` and
  `1.0` hash as distinct Python integer and float values, including inherited
  root CRS values within the configured decoded-size limit and streamed root geometry documents converted
  into Features. Direct ArcGIS FeatureServer imports hash the raw source records
  before service normalization. The scheduled Node importer also preserves the
  source numeric tokens in the generated Feature hashes it submits. Oversized
  features with injected CRS now fail the same configured decoded-size check as the
  reference. Generated PBF feature hashes treat geometry coordinates as Python
  floats. Shapefile feature hashes use DBF field types to retain integer versus
  float values and include the source `.prj` text in the decoded feature.
  DBF integer fields with zero decimal places are read exactly and staged as
  numeric JSON tokens, including values beyond JavaScript's safe integer range.
  Geodata PostgreSQL pools preserve large JSON/JSONB integers as `bigint`, and
  the API writes those values back as numeric JSON tokens. Binary format hashes
  and uncommon geometries or CRS definitions still need fixture qualification.
  Candidate creation, queue creation, status, hashes, and outbox events
  finalize in one transaction. The final event is assembled in PostgreSQL to avoid
  retaining every feature summary in the worker heap.
  Direct JSON imports and durable source-object references honor the configured
  body and upload limits. The direct JSON import path still materializes the
  normalized collection; multipart GeoJSON FeatureCollections and top-level
  feature arrays stream one feature at a time. Single Features and supported
  geometry documents are normalized as one item. Root `crs` and
  `spatialReference` metadata is applied to features without an explicit `crs`,
  matching the reference reader. Shapefile
  source bytes and decoded
  records now stream via bounded temporary files, matching the reference's
  configurable expanded-size cap (1 GiB default) and reproject coordinates
  using `.prj` metadata.
  NULL shape records fail preprocessing because PyShp cannot represent them as
  GeoJSON.
  The streaming parser's less common geometry types and uncommon CRS
  definitions still need parity qualification before broad Shapefile parity can
  be claimed.
  The adapter catalogue and admin selector now expose only import formats the
  current boundary can decode. The admin file picker accepts GeoJSON and OSM
  PBF and Shapefile ZIP files up to their configured upload limits, which
  default to the shared 1 GiB cap.
  Durable object references from the configured import bucket are also
  bounded, hash-checked, validated as GeoJSON, and staged in the worker's
  normalized source format.
  Import cancellation is available for queued and active preprocessing runs:
  queued sources are discarded immediately, while workers honor active
  requests at the candidate staging checkpoint and clear temporary source data.
  A worker restart recovers runs left in the CANCELLING state.
  Persisted conflation candidates can be paged by resolution and resolved with
  reviewer history, idempotency, and a transactional outbox fact. Candidate
  IDs use the first 32 hexadecimal characters of SHA-256 over the sorted entity
  pair; pages preserve the reference's ID order, and list and resolution records
  retain the programme and creation/update timestamps. Decision values retain
  case-sensitive enum
  validation, and conflation notes preserve submitted JSON values without
  coercion or truncation. Import candidate validation and promotion also
  preserve submitted note JSON values without
  coercion or truncation; `geo/006` migrates the stored validation note from
  text to JSONB while retaining existing text values as JSON strings. The Admin
  includes a role-gated conflation workspace for filtering candidates, inspecting
  match signals and prior decisions, and recording resolutions. Entity import
  promotion now searches overlapping PostGIS bounding boxes, computes the
  baseline name/containment/overlap/distance/jurisdiction score, using Python
  Unicode casefolding and whitespace stripping for the name signal, and applies
  `SequenceMatcher`'s 200-code-point popularity heuristic and ties-to-even
  rounding to six decimal places. Bounding-box centroid coordinates use
  seven-place ties-to-even rounding before distance scoring. It stores
  deduplicated candidates at the existing 0.55 threshold.
  The supported import
  adapter catalogue, provider-derived location hierarchy, and authorized
  paged import-run status reads are also exposed. Import finalization now
  discards staged candidates and queues, marks terminal runs processed, and
  records a transactional outbox fact. Authenticated entity audit
  reads combine the entity's review histories with durable audit events. Tile
  reads return the legacy GeoJSON FeatureCollection shape, including its
  feature cap, cache metadata, and tile metadata; they include all lifecycle
  statuses as the reference handler does. Tile bounds use the reference
  Web Mercator conversion, and z/x/y path values use Python integer syntax,
  including Unicode decimal digits and numeric underscores.
  A separate scheduled importer can poll due refresh schedules and fetch
  GeoJSON or ArcGIS FeatureServer data from explicitly allowlisted HTTPS hosts.
  It remains disabled unless `GEODATA_IMPORTER_ENABLED=true`; deployment and
  live-source qualification remain outstanding.
- Award definitions now support public published-only reads, administrative
  draft create/edit, review submission and decisions, print-readiness
  validation, publication, and retirement. Saved and published facts commit to
  the Activity outbox with their definition updates. Listing filters, counting,
  and paging for definitions, requests, assets, and issuances now run in
  Activity PostgreSQL so the API reads only one page. Certificate preview
  resolves its background asset by indexed metadata instead of reading the
  entire asset catalogue. Preview names preserve submitted whitespace and
  truncate at 200 Unicode code points, matching the Python renderer. Custom
  text labels and award version integers follow Python whitespace and digit
  parsing rules. Award evaluation and
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
  terminating them. Notice payloads and deduplication keys retain the producer's
  event ID spelling, while consumer checkpoints use normalized UUIDs. Its
  UUID parsing accepts nil IDs and all version/variant bit patterns supported
  by Python's UUID parser.
  Malformed envelopes without a usable event ID use the same deterministic
  subject/sequence digest UUID as the Python consumer.
  Recipient extraction follows Python truthiness and mapping fallbacks so
  malformed truthy recipient fields retry and dead-letter instead of silently
  dropping a notification.
  metrics listener exposes `/healthz`, `/readyz`, and
  Prometheus metrics for bounded delivery outcomes and unresolved dead letters;
  readiness checks Activity PostgreSQL and the NATS connection. An audited CLI
  redrive reuses pending audit records and a stable JetStream message ID. Worker
  replay can bind `ACTIVITY_NOTIFICATION_DURABLE` at the explicit
  `ACTIVITY_NOTIFICATION_START_SEQUENCE`; `ACTIVITY_NOTIFICATION_MAX_MESSAGES`
  stops the process after that many successfully handled or duplicate events.
  Recovery evidence remains outstanding.

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
  The `outbox:admin` CLI now lists bounded dead-letter metadata and transactionally
  requeues an event from one explicitly selected owner database with its previous
  attempt count and error retained in the redrive audit.
  `/healthz` reports liveness and `/readyz` reflects database and NATS status;
  outage/recovery evidence remains outstanding. Activity
  job redrive is audited and available to
  administrators; the Activity worker now extends active job leases while
  long batches run and repairs missing queued-job outbox commands. Geodata import, promotion, and deletion work extends owner
  leases during long jobs; each work durable is polled concurrently up to its
  registered `max_ack_pending` limit. Import run leases and database heartbeat cadence
  follow `MYOTA_IMPORT_LEASE_SECONDS` (900 seconds by default) and
  `MYOTA_IMPORT_HEARTBEAT_SECONDS` (30 seconds), with Python-compatible integer
  parsing and the reference minimums. JetStream progress acknowledgements
  renew independently at one third of each durable's ACK wait. Failed progress acknowledgements do not fail
  the active owner operation. Cancellation reconciliation follows
  `GEODATA_CANCELLATION_RECONCILE_SECONDS` (30 seconds by default, at least 5).
  `GEODATA_WORKER_ACK_WAIT_SECONDS`, `GEODATA_WORKER_MAX_ACK_PENDING`, and
  `GEODATA_WORKER_MAX_DELIVERIES` override the registered Geodata durable
  policies consistently in provisioning and runtime validation.
  Work IDs accept all canonical UUID version and
  variant bits; `causationId` is optional, and exhausted invalid deliveries use
  the reference's UUID fallback and payload event-type precedence. Stale
  dispatch recovery and Geodata retention are
  implemented; outage/recovery evidence remains outstanding.
- Baseline Admin Vue application and static Participant application now live
  under `web/` as separate deployable artifacts. Admin local checks/build are
  part of CI. A static source scan resolves 62 concrete Admin HTTP method/path
  pairs, all present in the OpenAPI contract. This does not establish payload
  or workflow parity. The Participant UI includes localized published programme
  content; paged approved/candidate entity catalogue and map; map-picked new point and existing-candidate proposals; profile editing
  and image management; published award and level catalogue with eligible-level
  requests; activation creation, QSO entry, and
  close; and point, line, polygon, and multipart map geometries. It lacks
  browser-level compatibility coverage. Visual/accessibility review and
  deployment integration also remain open.
- Cross-version transfer tooling now has read-only preflight, checksummed dump
  staging for four legacy sources and three targets, ledger adoption,
  restore/migration steps, the legacy Email merge into Core, and a read-only
  per-owner database validation report. Semantic parity review and
  disposable-database rehearsal remain open; see the
  [database transfer plan](operations/cross-version-data-transfer.md), image
  publication, deployment manifests, and
  production observability configuration. A reusable Docker recipe now builds
  one unprivileged runtime image per Nest application. An owner-scoped database
  migration runner applies the checked-in SQL baseline and forward migrations
  with checksums and per-file transactions; production cutover and rollback
  rehearsals remain outstanding.
- Email delivery. The NestJS consumer rejects invalid UTF-8 and invalid UTC
  date-time values before validating `email.send.v1`, including lowercase `t`
  separators rejected by the reference checker. It resolves recipients
  through Identity using `MYOTA_IDENTITY_URL`, with `IDENTITY_INTERNAL_URL`
  retained as an alias, accepts schema-valid producer names and UUID version and
  variant bits, and applies the schema's Unicode code-point lengths to bounded
  envelope and template text. Address validation follows the reference's
  254-character, nonempty local/domain, space, and CR/LF rules. SMTP TLS mode
  is case-insensitive, and port/timeout values use decimal parsing consistent
  with Python's configuration parser, including Python whitespace and Unicode
  decimal digits. It sends through TLS-configured SMTP
  and records deduplication, attempts, and redacted dead letters in the Core
  database. The former fourth email database is removed from the target. Identity production
  and deployment qualification remain outstanding. With `MYOTA_OTEL_ENABLED=1`,
  the worker exports W3C-parented delivery spans, bounded outcome and duration
  metrics, and privacy-safe delivery logs over OTLP; exporter setup is fail-open.
  Prometheus metrics and `/healthz`/`/readyz` remain available independently. Retry backoff
  uses the greater of JetStream delivery count and the persisted attempt count,
  including after audited redrive. An audited
  redrive CLI resets one dead-letter record and records the operator's reason
  before the original command is replayed from its producer outbox.

Email delivery is not end-to-end qualified. Contract presence and successful
builds do not count as function parity. Track completion against the
[parity matrix](parity-matrix.md).
