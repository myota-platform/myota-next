# Function parity matrix

This is the acceptance inventory for the new implementation. The copied
`contracts/openapi.yaml` and event schemas are the first compatibility
baseline. The [API operation traceability index](api-operation-traceability.md)
maps contract operations to Nest controllers; it establishes source ownership,
not behavioral completion. Current implementation reference:
[`myota`](https://github.com/myota-platform/myota/tree/7f904a5130e59006765cf882956a4adbfecb17ec).

## HTTP compatibility

NestJS HTTP APIs format framework and parser failures with the shared `Problem`
schema in the OpenAPI contract. Responses carry request and correlation IDs in
headers and in the problem body. `X-Trace-ID` follows the request ID used by
Nest observability. Identity login preserves the reference status
behavior: invalid credentials return 400, while permission and rate-limit
failures return 403. Other NestJS 401 permission exceptions also map to 403.
Malformed JSON and oversized JSON bodies use the reference's 400
`invalid_request` response shape and details.
The Gateway forwards W3C `traceparent` and `tracestate` headers to the owning
API and passes trace headers back to clients when an upstream provides them.

## Domain functions

| Area           | Required parity                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity       | Preserve the intentionally disabled public-registration response; login, refresh, logout, recovery, current profile and profile images; account creation and administration; role definition and assignment; callsign creation, evidence, verification, primary selection and retirement; OIDC mapping; service tokens; account export/deactivation; security events; authorization scopes and abuse controls.                                    |
| Programmes     | Programme create/read/update/archive; shared category catalog and programme assignments; programme content and policy draft lifecycle (save, submit, review, publish); configuration coverage and theme/content delivery.                                                                                                                                                                                                                         |
| Geodata        | Catalog search, paging, bounding box and tiles; source adapters; pasted imports and resumable multipart uploads; validation/preprocessing queues, duplicate warnings and promotion; provenance, audit, review and lifecycle; metadata, categories, geometry and location edits; asynchronous location enrichment; refresh schedules; conflation; authorized deletion with Activity impact calculation; retention.                                 |
| Activity       | Activation lifecycle; single and batch QSO writes with import provenance; ADIF and QSO ingestion; correction requests and review; public history, results, leaderboards and statistics; statistics rebuild; award design and lifecycle; conditions, levels, evaluation and progress; requests, issuance, assets, previews, certificate rendering and artifact retrieval; notification records and authorized operational views.                   |
| Email delivery | Preserve the `email.send.v1` work contract, Identity-owned recipient lookup, allowlisted templates, TLS SMTP, Core-owned deduplication and dead-letter ledger, bounded retry, audited recovery, privacy-safe telemetry, and separate worker deployment. The NestJS consumer, audited redrive CLI, Prometheus metrics, and optional OTLP traces, metrics, and logs are implemented; Identity production and deployment qualification remain gated. |

Identity currently implements disabled public registration, password login,
refresh rotation, logout revocation, recovery request/reset, current-account
reads, owner-only profile updates, account creation, and administrator account
listing, owner/global account reads and account role reads in NestJS. The role catalogue endpoint returns built-in and persisted
custom roles under the existing authorized scopes; custom role creation and
partial updates are backed by Core transactions and security/outbox events.
Administrative account updates now preserve profile, password, status,
anonymization, and role replacement behavior in Core transactions. As in the
reference handler, changing status alone does not anonymize the account or
revoke its sessions; existing refresh sessions also remain rotatable, and both
session revocation and anonymization happen when `anonymize` is true. Callsign
creation, evidence, verification, primary selection, and retirement also write
to the relational Core model and outbox.
These are the first implemented slices; they still need automated
compatibility coverage before they count as parity complete.
Identity startup now idempotently provisions the configured bootstrap account,
sets its password only when no credential exists, ensures its global operator
role, and writes the corresponding Core outbox and security events.
Administrator account search now uses full default Unicode 15.0 case folding,
matching the Python 3.12 reference. It scans only IDs, names, email addresses,
and status for eligible accounts, folds names and email addresses before
slicing the result page, then loads profile, role, and callsign details only
for that page. The Admin Identity view follows the returned page metadata and
lets administrators move between matching account pages without loading the
full account list. Login, recovery, account creation, and account updates also
use Unicode case-folded Core email keys with a unique index; the forward
migration checks legacy JSONB emails for case-fold collisions before cutover.
OIDC provider registration remains create-only, matching the pinned Python
handler; repeated requests create separate mappings even when they carry the
same optional `Idempotency-Key`. Mapping field values are stored verbatim;
non-empty whitespace-only strings and explicit `null` values for optional
`scopes` and `enabled` fields are preserved as by the reference. Its runtime
response is `201` even though the preserved upstream OpenAPI contract declares
`200`.

Activity has an initial activation and single-QSO slice: activation list/create/read/close,
normalized QSO writes, validity checks, ownership checks, subject aggregates,
transactional event outbox records, idempotency responses, and award recalculation
jobs. Activation resource updates require `status=CLOSED`, and close ignores
`Idempotency-Key`, so repeated closes fail after the first transition as in the
reference. Explicit falsey `endedAt` values are treated as null. Activation
validity defaults come from `programmeRules` only, even
when validation uses the `rules` alias. Timestamp normalization accepts lowercase `t`, ISO week dates,
one-character date/time separators, and fractional-second time-zone offsets
supported by Python's
`datetime.fromisoformat`. QSO ingestion requests also persist bounded,
owner-scoped jobs with a status read path. `sourceFormat` defaults only when
omitted and otherwise reaches the worker unchanged, matching the Python
handler. The separate Activity worker consumes its six registered JetStream
durables with database leases, progress acknowledgements, retries, and
dead-letter state. Activity notification events use a separate durable
consumer. Recovery evidence remains open. QSO correction requests and
administrator review are also implemented, ignore `Idempotency-Key` as the
reference does, and rely on the database relation for request QSO existence.
Applied changes queue recalculation. Award definition draft,
review, publish, and retire APIs are implemented. Award progress reads and
evaluation/recalculation job APIs persist versioned progress and qualification
notifications through the Activity worker. Award requests validate eligibility,
issuance is transactional and permanent, and PDF render jobs store artifacts in
S3-compatible storage with authorized presigned download URLs. The Admin can
render transient PDF previews from mock data and registered assets without
creating an issuance or object; preview and issuance use the same renderer.
Award definition saves and eligible award requests return HTTP 201 when created
and 200 when they return an existing record, matching the reference handlers.
Optional preview artwork and signature inputs use the reference's truthiness
defaults, so falsey values behave as absent.
Registered award assets and bounded content storage are implemented. Award
asset dimensions use Python integer conversion, including float truncation,
boolean inputs, and strict parsing of numeric strings.
condition operators default to `GTE` only when omitted; an explicit `null` is
an unknown operator and evaluates false. Entity-type comparisons also preserve
Python's absent-versus-null string conversion and iterable handling. `AND`,
`OR`, and `NOT` preserve Python truthiness, iteration, and omitted-versus-null
behavior for nested conditions. Award asset IDs and recalculation subject lists
use Python truthiness defaults, issuance defaults `dateObtained` only when the
field is omitted, and award-definition optional fields retain explicit null
values where the reference uses dictionary defaults only for omitted fields.
Award evaluation stringifies an explicit null metric as Python `None` instead
of replacing it with the default metric.
ADIF uploads now pass
authorization, malware checks, and object storage before durable queueing; the
Activity worker parses records, records successes and rejects, updates
aggregates, and reports import status. CSV file uploads now validate bounded
UTF-8 input and queue normalized rows through the same ingestion job. CSV QSO
ingestion is an addition to the legacy behavior: the Python Activity service
exports public results as CSV but has no CSV QSO ingestion route. It is tracked
as an extension, not as evidence of legacy parity. Remaining
Activity notification producers cover ADIF completion and award qualification;
the durable consumer handles cross-service Identity and Geodata decisions.
ADIF validity-window handling aborts the full import before writing QSOs when
one is outside the activation window. The Nest worker commits the import's
`PROCESSING` state before batch work, then retries the work job and dead-letters
it at the delivery limit, leaving the import `PROCESSING` as the Python
reference does. A closed activation follows the same reference boundary:
normalized records fail the insert and retry the job, while an import with no
normalized records can complete with its rejected-row errors. Automated
compatibility and outage/recovery qualification remain outstanding.
Failed or queued Activity jobs can be redriven by administrators with
an audited reason; long-running Activity jobs now extend their 120-second leases
from a separate database connection while processing. Statistics listing and rebuild-job APIs,
transactional snapshot rebuilds, and owner-scoped notification reads are
implemented. ADIF import creation, processing, and status reads are implemented.
Activity activation history, public activation history, and statistics pages
apply database limits and offsets while retaining their existing page metadata;
public result exports remain complete exports.
Public leaderboard category values are uppercased and passed through to the
aggregate query, matching the reference: unrecognized categories return an
empty `items` array instead of a validation error.
The notifications endpoint preserves the reference's unpaged `{ items }`
response and ignores `page` and `pageSize` query parameters. The Admin Activity
view requests that response without adding page controls or inferred metadata.
Statistics rebuild requests deduplicate by programme and UTC day, ignoring a
caller-supplied `Idempotency-Key`, as in the reference implementation.
The Admin Activity page opens activation details and normalized QSOs, provides
independent bounded paging for activation history and programme-scoped
statistics snapshots, and allows Activity administrators to queue and inspect
rebuild jobs. It also lists notifications for the signed-in account. These
controls follow the read and admin scopes enforced by the API.
Activity entity-deletion impact reads and idempotent cascades also remove
linked QSOs and correction rows, rebuild subject aggregates, invalidate affected
activations, and enqueue award recalculation jobs.
Geodata deletion now calculates impact, requires explicit confirmation, invokes
the Activity cascade with a stable idempotency key, and transactionally removes
Geodata references and the entity. Import preprocessing, promotion, deletion,
and location enrichment now consume their registered JetStream durables and
claim only the referenced Geodata job. Long-running import, promotion, and
deletion work extends owner-database leases and JetStream acknowledgements. A
bounded reconciler republishes stale queued work and expired leases through the
transactional outbox. Scheduled retention removes eligible import history and
owned source objects, expires stale multipart uploads, and preserves materialized
entities. Outage/recovery evidence remains outstanding. Activity lease extension
is supported for long-running jobs.
Tagged load-test cleanup now requires explicit environment opt-in, global
operator authorization, exact confirmation, terminal work, safe object scope,
and a no-Activity-impact check before deletion.
Geodata provides PostGIS-backed public
entity list/detail reads with filters and bounds, the import adapter catalogue,
provider-derived location options, and authorized import-run list/status reads;
authenticated audit reads and GeoJSON vector tile collections are also
implemented with the legacy tile metadata and feature selection behavior.
JSON GeoJSON, WFS GeoJSON, and ArcGIS FeatureServer JSON import creation stores
normalized GeoJSON source documents in S3-compatible storage and queues
idempotent import runs transactionally. ArcGIS geometries with WGS84 and
Web Mercator spatial references are normalized to WGS84; other EPSG WKIDs are
reprojected when the installed `proj4` definitions support them. Reprojected
coordinates retain XY only, while unprojected WGS84 coordinates retain extra
ordinates, matching the pinned Python transform path. Web Mercator exponential
overflow rejects the feature as in Python. Pasted KML and GPX are
also converted to GeoJSON with XML document types rejected and bounded
feature/coordinate counts. Multipart uploads accept GeoJSON and bounded
Shapefile ZIP archives with matching sidecars (`SHAPEFILE`, `SHP`, and the
legacy `PARKSERVE_US` format alias); Shapefile coordinates are reprojected from
the supplied `.prj` to WGS84, and NULL shape records fail preprocessing as in
PyShp's GeoJSON conversion. OSM PBF uploads are decoded by
`osmium-tool` in the Geodata worker image, preserve OSM tags and type/id source
references, and emit the configured hiking, protected-area, point, path, and
multipolygon features using a temporary disk-backed node-location index.
Shapefile and PBF working directories use `MYOTA_UPLOAD_SPOOL_DIR` when set,
and otherwise use the OS temporary directory. PBF source bytes stream to disk
with checksum verification. API admission and
worker decoding share the same configured upload cap, defaulting to 1 GiB or
the optional format-specific override. PBF output is streamed one feature at a
time, bounded by the per-feature and total-feature limits, into staged batches bounded by
`MYOTA_IMPORT_BATCH_SIZE` and `MYOTA_IMPORT_BATCH_BYTES` (100 features and
32 MiB by default),
with the configured per-feature byte limit (16 MiB by default), 250,000 vertex
limit, and configured feature cap. GeoJSON multipart uploads stream their
source and yield one parsed
feature at a time, with the same shared API/worker 1 GiB upload cap or optional
format-specific override, 16 MiB
per-feature size by default, 250,000 vertices, and the configured feature
count. `GEODATA_MAX_IMPORT_FEATURES` uses Python-compatible integer parsing in
both API and worker, including zero and negative limits; malformed values fail
instead of silently falling back. The `MYOTA_IMPORT_MAX_FEATURE_VERTICES` and
`MYOTA_IMPORT_MAX_SHAPEFILE_EXPANDED_BYTES` settings use the same parser and
control all format vertex limits and Shapefile expanded size (250,000 vertices
and 1 GiB by default). The shared `MYOTA_IMPORT_MAX_FEATURE_BYTES` setting controls decoded
feature size in GeoJSON, KML/GPX, Shapefile, and PBF imports (16 MiB by
default). Prepared candidates and validation errors are staged by import attempt in Geodata
PostgreSQL; candidate creation, import status, processing queue, and the
compatible outbox event are finalized atomically, with event arrays assembled
in the database. Record hashes use Python float formatting and Unicode
code-point key ordering. Streamed GeoJSON and direct GEOJSON/WFS JSON imports
retain raw numeric tokens in features and injected root CRS values within the
configured decoded-size limit (`MYOTA_IMPORT_MAX_FEATURE_BYTES`, 16 MiB by
default).
Streamed root geometry documents converted into Features retain those tokens as
well. Direct ArcGIS FeatureServer imports hash raw source records before API
normalization. The scheduled Node importer preserves source numeric tokens in
the generated Feature hashes it submits. Streamed imports reject features whose
inherited CRS pushes their decoded size over the reference's configured limit.
Generated PBF hashes now retain Python float formatting for geometry
coordinates. Shapefile hashes use DBF numeric field types to distinguish integer
and floating-point attributes and include the source `.prj` text. Binary-format
integer attributes are staged without precision loss, including values beyond
JavaScript's safe integer range. Geodata PostgreSQL pools preserve those values
on reads, and the API returns them as numeric JSON tokens. Hash and feature
parity still requires fixtures for binary formats and uncommon geometries or
CRS definitions. The direct JSON import path materializes
the normalized collection, while multipart GeoJSON streams source features.
Shapefile multipart uploads stream to
temporary disk and decode records one at a time, with the same shared API/worker
1 GiB upload cap or optional format-specific override, a 1 GiB expanded-size cap, 16 MiB
per-feature size by default, 250,000 vertices, and the configured feature
count. Less
common geometry types and uncommon CRS definitions still need compatibility
qualification against the reference parser.
Import adapters infer feature names from the reference alias catalogue before
validation, using Python-compatible Unicode casefolding, whitespace collapse,
and 300-code-point truncation. The worker validates WGS84
geometries, stages candidates with provenance and 50 m duplicate
warnings, records errors, and emits the preprocessing fact. Conflation name
similarity uses Python Unicode casefolding and whitespace stripping, plus the
`SequenceMatcher` popularity heuristic for reference names of 200 or more code
points; signal values use Python's ties-to-even rounding to six decimal places.
Bounding-box centroids are rounded to seven decimal places before distance
scoring. Community proposals
join this pipeline, and community proposals and imported features preserve
validated attachment metadata before promotion. Multipart/resumable
uploads are implemented with owner-scoped durable sessions, bounded binary
parts, checksum and malware scanning, and transactional completion up to the
worker's configured source limits. GeoJSON, Shapefile, and PBF multipart
uploads use their larger configurable limits. Durable object references from the configured
import bucket are bounded, hash-checked, validated, and staged as normalized
worker inputs; object keys retain their submitted value when checked. Shapefile
ZIP intake selects the first `.shp` member and requires
matching `.shx` and `.dbf` sidecars, following the reference importer.
Refresh schedules can be listed and created, and manual complete-
snapshot runs queue GeoJSON imports, promote validated candidates, record
manifests, and apply disappearance policy after successful preprocessing.
Import promotion generates deduplicated conflation candidates from overlapping
PostGIS bounding boxes using the baseline 0.55 scoring threshold. Failed
promotion queues can be redriven with a required reason recorded in queue
metadata and the outbox. The Admin now lists filtered, paged conflation
candidates and records decisions, optional survivor selection, reviewer, and
note through the audited API. Admin users with import scope can also create and
page refresh schedules, then queue a complete GeoJSON snapshot manually. A
separate Node importer polls due schedules and also accepts the reference
`GEODATA_IMPORT_SPEC` one-shot complete-snapshot input. It
fetches GeoJSON or ArcGIS FeatureServer data only from allowlisted HTTPS hosts;
it rejects redirects and reads the complete response. Scheduled fetches use the
schedule run API; one-shot imports post to the ordinary complete-snapshot import
API. The
shared `GEODATA_MAX_IMPORT_FEATURES` limit is checked consistently by the
importer, API, and worker. The API retains the reference timestamp updates; the
importer calculates automatic eligibility from `lastRunAt + intervalSeconds`.
`GEODATA_IMPORTER_ENABLED` keeps it opt-in. Deployment, live-source
qualification, and outage/recovery evidence are outstanding.
Refresh intervals preserve arbitrary-precision integer values and follow
Python `int()` whitespace, Unicode decimal, underscore, boolean, and
float-truncation behavior through API parsing, persistence, and importer due-time
calculation.
Multipart upload part numbers follow Python integer parsing for whitespace,
Unicode decimal digits, and underscores before enforcing the 1 through 10000
range. Multipart expected sizes follow Python `int()` conversion for booleans,
finite floats, and integer strings with Unicode digits or underscores before
the source-specific byte limit is enforced.
Complete snapshot imports are also accepted on the ordinary import path; the
worker applies disappearance policy after the final batch is staged, before
candidate review or promotion, matching the reference worker lifecycle.
Disappearance policy values retain their submitted casing and are checked at
snapshot reconciliation time; malformed values therefore fail worker
processing instead of being normalized or rejected at request creation.
Finalization removes staged candidates and queues transactionally
while preserving the import summary and materialized entities. Pending
candidates can be paged; administrators can confirm or
reject selected rows transactionally. Candidate validation checks required
fields first and preserves duplicate IDs in submitted order; validation status
uses Python truthiness and string conversion before checking supported values.
Promotion selection
applies required-field checks before type and status validation, then sorts and
deduplicates IDs without a separate 500-ID cap. Selected candidates can be queued
for CANDIDATE or scope-gated APPROVED promotion; the worker persists entities,
category and source links, audit/outbox events, and queue outcomes. Entity
review, metadata, category, and geometry changes, conflation decisions, and
import candidate validation and promotion preserve submitted notes without
coercion or truncation, matching the Python handlers. Entity review status
falls back from `status` to legacy `decision` using Python truthiness; candidate
proposal identity remains in `candidateSource`, and `sourceRef` uses the normal
import fallback. Import source identity selects `sourceKey`, `url`, then `name`
using Python truthiness and preserves submitted whitespace. Proposal feature
objects follow adapter normalization without an extra `type` requirement.
Falsey feature properties default to an empty object, while truthy non-object
properties are rejected as malformed input.
Proposal and direct-import idempotency scopes keys by owner and actual request
path, fingerprints the parsed request body before validation, and rejects
changed-body reuse while preserving integer versus float values. The request
lock spans proposal/import validation and source-object, import, and outbox
creation. Import candidate validation now uses the same owner/path-scoped key
and request fingerprint, replays successful results before body validation,
and rejects changed-body key reuse. Import promotion applies the same request
contract while retaining scope checks and atomic queue/outbox writes. Entity
review, metadata, category, geometry, and location-enrichment writes also use
the owner/path/body contract and replay before mutation validation. Conflation
resolution uses the same contract while preserving its transactional history
and outbox write. Refresh schedule creation and manual runs also scope keys by
owner and path, check the request fingerprint before validation, and reject
changed-body reuse; a run replay preserves the prior import and schedule result.
Deletion-job creation and confirmation also replay by owner, path, and body,
including a confirmation retry against an already completed job. Import
finalization and failed promotion queue redrive use the same request fingerprint
and successful-result replay.
Candidate validation notes are stored as JSONB with existing text values
preserved as JSON strings. If-Match protected name, website, description,
geometry, category, and location edits are also implemented. Entity status,
import candidate, and conflation review actions have corresponding Admin
workflows; broader payload and workflow compatibility qualification remains
outstanding.

## User applications

| Application     | Required parity                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin web       | Login and role-aware navigation; account and role management; programme/category/content/policy administration; Geodata catalogue, import, preprocessing, review, entity editing, maps and deletion; Activity/QSO and award administration; observability access. Preserve accessible keyboard workflows, confirmation of destructive actions, conflict handling, bounded paging, resumable upload behavior, and accurate loading/error states. |
| Participant web | Programme selection, public programme content and rules, approved/candidate entity table and map, candidate proposal, authenticated profile editing and cropped profile-image upload, published award/level display and request, activation creation, QSO entry, and activation close. Keep programme policy, callsign authorization, and eligibility decisions on owning services.                                                             |

The baseline Admin and Participant applications are carried forward under
`web/` with separate deployment artifacts. The Admin build is checked in CI;
a static source scan resolves 62 concrete Admin HTTP method/path pairs, all
present in the OpenAPI contract. This does not establish payload or workflow
parity. The Admin Awards screen uses independent bounded paging for award
definitions, requests, and issuances; the asset catalogue follows its API pages
for design selection. The Participant client includes localized published programme content,
paged approved/candidate entity catalogue and map, map-picked point proposals and existing-candidate proposals, published award and level catalogue with eligible-level requests, activation creation,
single-QSO entry, profile editing and image management, but those workflows lack
browser-level compatibility coverage. The award catalogue follows all API pages.
Remaining work
includes accessibility/visual review and deployment integration. Its public
map renders point, line, polygon, and multipart entity geometries.

## Workers and operations

- Activity workers: QSO ingestion, ADIF processing, award evaluation and
  recalculation, certificate rendering, and statistics rebuild are consumed
  from their registered JetStream durables up to each durable's configured
  `max_ack_pending` concurrency. Database leases and message progress
  acknowledgements protect long jobs; notifications are handled by
  the separate consumer described below. ADIF source-object retention is
  scheduled, and queued jobs missing an outbox command are repaired periodically;
  other retention and recovery evidence remain open.
- Identity maintenance: expired recovery tokens, revoked sessions, expired
  revocations, rate-limit windows, old security events, and aged orphan profile
  images are cleaned by a separate Core-owned worker.
- Activity notification consumption: exact durable validation, transactional
  processed-event/checkpoint and notification writes, deduplication, bounded
  retry, redacted poison-event dead-lettering, and audited CLI redrive are
  implemented, with outcome and unresolved-dead-letter metrics. Named replay
  durables require an explicit start sequence, and optional message limits allow
  bounded replay runs. Recovery evidence remains open.
- Geodata workers: registered JetStream consumers for import preprocessing and
  promotion, confirmed entity deletion, and location enrichment are implemented.
  Each durable is polled concurrently up to its registered `max_ack_pending`
  limit.
  `/healthz` and `/readyz` expose liveness and Geodata PostgreSQL/NATS
  readiness. Import run leases and database heartbeats use the Python-compatible
  `MYOTA_IMPORT_LEASE_SECONDS` and `MYOTA_IMPORT_HEARTBEAT_SECONDS` settings;
  cancellation reconciliation uses `GEODATA_CANCELLATION_RECONCILE_SECONDS`
  (default 30 seconds, minimum 5); JetStream ACK extensions follow one third of
  the registered durable ACK wait. Optional `GEODATA_WORKER_ACK_WAIT_SECONDS`,
  `GEODATA_WORKER_MAX_ACK_PENDING`, and `GEODATA_WORKER_MAX_DELIVERIES` settings
  are shared by JetStream provisioning and worker policy validation. The
  per-durable `GEODATA_WORKER_PREPROCESSING_MAX_ACK_PENDING`,
  `GEODATA_WORKER_PROMOTION_MAX_ACK_PENDING`,
  `GEODATA_WORKER_DELETION_MAX_ACK_PENDING`, and
  `GEODATA_WORKER_ENRICHMENT_MAX_ACK_PENDING` settings override the global
  pending limit and are applied consistently at provisioning and runtime.
  The reference Python API also exposes separate `MYOTA_UPLOAD_WORKERS`,
  `MYOTA_IMPORT_WORKERS`, `MYOTA_LOCATION_WORKERS`, and
  `MYOTA_DELETION_WORKERS` thread-pool limits. They do not map one-to-one to
  Nest's four durable consumers, and the Nest runtime does not accept those
  legacy settings. Before operational parity is qualified, compare per-work
  throughput and resource limits under representative loads, then tune the
  registered durable policies and worker replica counts together.
  The Geodata API exposes `/metrics` with PostGIS tile-query duration and
  slow-query counters; `MYOTA_SLOW_QUERY_THRESHOLD_MS` retains its 250 ms
  default and controls the slow-query counter. The reference's `entity_upsert`
  series timed a full-snapshot synchronization pass; the row-authoritative
  implementation has no equivalent pass and does not reuse that label for
  individual writes.
  Stale queued and expired work is re-enqueued through the owner outbox.
  Scheduled import and upload-session retention is implemented; outage/recovery
  evidence remains open.
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
  attempts and error. See [outbox recovery](operations/outbox-recovery.md).
  Operational recovery evidence is not complete yet.
- Runtime: preserve migrations, health/readiness, metrics, logs, traces,
  backups, restore paths, NATS topology, object storage buckets, and separate
  service/worker deployment units. Activity database pools honor the
  `MYOTA_ACTIVITY_DB_POOL_MAX` override before `MYOTA_DB_POOL_MAX`, defaulting
  to 12 connections; Core and Geodata use the shared override and default to 10.

## Compatibility and completion evidence

Parity is complete only when every current OpenAPI operation and registered
event is mapped to an implementation and automated compatibility check, and
when user workflows and worker behavior have equivalent tests. The copied
event registry currently contains 68 fact schemas and 11 work-command schemas.
The NestJS route guard confirms that all 140 OpenAPI operations have controller
routes; this verifies route presence only, not request, response, authorization,
or persistence parity.
Checks must
cover success, authorization, validation, conflicts, persistence, retries,
redelivery, idempotency, and failure recovery where relevant. UI parity also
requires browser-level workflow coverage. Database parity includes migration
and data-transfer checks for all three database targets.

The inventory must be refined against the current service tests, UI routes,
worker topology, and migration data before each area is declared complete.
Operational and production qualification are separate gates from API-level
parity.
