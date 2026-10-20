# Function parity matrix

This is the acceptance inventory for the new implementation. The copied
`contracts/openapi.yaml` and event schemas are the first compatibility
baseline. Current implementation reference:
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

| Area           | Required parity                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity       | Preserve the intentionally disabled public-registration response; login, refresh, logout, recovery, current profile and profile images; account creation and administration; role definition and assignment; callsign creation, evidence, verification, primary selection and retirement; OIDC mapping; service tokens; account export/deactivation; security events; authorization scopes and abuse controls.                  |
| Programmes     | Programme create/read/update/archive; shared category catalog and programme assignments; programme content and policy draft lifecycle (save, submit, review, publish); configuration coverage and theme/content delivery.                                                                                                                                                                                                       |
| Geodata        | Catalog search, paging, bounding box and tiles; source adapters; pasted imports and resumable multipart uploads; validation/preprocessing queues, duplicate warnings and promotion; provenance, audit, review and lifecycle; metadata, categories, geometry and location edits; asynchronous location enrichment; refresh schedules; conflation; authorized deletion with Activity impact calculation; retention.               |
| Activity       | Activation lifecycle; single and batch QSO writes with import provenance; ADIF and QSO ingestion; correction requests and review; public history, results, leaderboards and statistics; statistics rebuild; award design and lifecycle; conditions, levels, evaluation and progress; requests, issuance, assets, previews, certificate rendering and artifact retrieval; notification records and authorized operational views. |
| Email delivery | Preserve the `email.send.v1` work contract, Identity-owned recipient lookup, allowlisted templates, TLS SMTP, Core-owned deduplication and dead-letter ledger, bounded retry, audited recovery, privacy-safe telemetry, and separate worker deployment. The NestJS consumer and audited redrive CLI are implemented; Identity production, telemetry, and production deployment remain gated.                                    |

Identity currently implements disabled public registration, password login,
refresh rotation, logout revocation, recovery request/reset, current-account
reads, owner-only profile updates, account creation, and administrator account
listing, owner/global account reads and account role reads in NestJS. The role catalogue endpoint returns built-in and persisted
custom roles under the existing authorized scopes; custom role creation and
partial updates are backed by Core transactions and security/outbox events.
Administrative account updates now preserve profile, password, status,
anonymization, and role replacement behavior in Core transactions. As in the
reference handler, changing status alone does not anonymize the account or
revoke its sessions; both happen when `anonymize` is true. Callsign
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
for that page. Login, recovery, account creation, and account updates also use
Unicode case-folded Core email keys with a unique index; the forward migration
checks legacy JSONB emails for case-fold collisions before cutover.
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
Registered award assets and bounded content storage are implemented. ADIF uploads now pass
authorization, malware checks, and object storage before durable queueing; the
Activity worker parses records, records successes and rejects, updates
aggregates, and reports import status. CSV file uploads now validate bounded
UTF-8 input and queue normalized rows through the same ingestion job. Remaining
Activity notification producers cover ADIF completion and award qualification;
the durable consumer handles cross-service Identity and Geodata decisions.
Automated compatibility and outage/recovery qualification remain outstanding.
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
The notifications endpoint now supports the contract's optional `page` and
`pageSize` parameters with database-bounded reads; requests without paging
parameters retain the prior unpaged response shape.
Statistics rebuild requests deduplicate by programme and UTC day, ignoring a
caller-supplied `Idempotency-Key`, as in the reference implementation.
The Admin Activity page opens activation details and normalized QSOs, lists
statistics snapshots in programme scope, and allows Activity administrators to
queue and inspect rebuild jobs. It also lists notifications for the signed-in
account. These controls follow the read and admin scopes enforced by the API.
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
authenticated audit reads and approved-entity vector tiles are also implemented.
JSON GeoJSON, WFS GeoJSON, and ArcGIS FeatureServer JSON import creation stores
normalized GeoJSON source documents in S3-compatible storage and queues
idempotent import runs transactionally. ArcGIS geometries with WGS84 and
Web Mercator spatial references are normalized to WGS84; other EPSG WKIDs are
reprojected when the installed `proj4` definitions support them. Pasted KML and GPX
are also converted to GeoJSON with XML document types rejected and bounded
feature/coordinate counts. Multipart uploads accept GeoJSON and bounded
Shapefile ZIP archives with matching sidecars (`SHAPEFILE`, `SHP`, and the
legacy `PARKSERVE_US` format alias); Shapefile coordinates are reprojected from
the supplied `.prj` to WGS84. OSM PBF uploads are decoded by
`osmium-tool` in the Geodata worker image, preserve OSM tags and type/id source
references, and emit the configured hiking, protected-area, point, path, and
multipolygon features using a temporary disk-backed node-location index.
PBF source bytes stream to disk with checksum verification; the default upload
limit is 256 MiB and can be raised to 512 MiB. Decoded PBF output is capped at
128 MiB and streamed one feature at a time into four-record staging batches,
with per-feature 16 MiB and 250,000 vertex limits and the configured feature
cap. GeoJSON multipart uploads stream their source and yield one parsed
feature at a time, with a 256 MiB default upload cap (512 MiB maximum), 16 MiB
per-feature size, 250,000 vertices, and the configured feature count. Prepared
candidates and validation errors are staged by import attempt in Geodata
PostgreSQL; candidate creation, import status, processing queue, and the
compatible outbox event are finalized atomically, with event arrays assembled
in the database. The direct JSON import path materializes the normalized
collection, while multipart GeoJSON streams source features. Shapefile multipart
uploads stream to temporary disk and decode records one at a time, with a 256
MiB default upload cap (512 MiB maximum), 1 GiB expanded-size cap, 16 MiB
per-feature size, 250,000 vertices, and the configured feature count. Less
common geometry types and uncommon CRS definitions still need compatibility
qualification against the reference parser.
Import adapters infer feature names from
the reference alias catalogue before validation. The worker validates WGS84
geometries, stages candidates with provenance and 50 m duplicate
warnings, records errors, and emits the preprocessing fact. Community proposals
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
separate Node importer polls due schedules and
fetches GeoJSON or ArcGIS FeatureServer data only from allowlisted HTTPS hosts;
it rejects redirects and responses above 16 MiB, then submits data through the
schedule run API. The API retains the reference timestamp updates; the importer
calculates automatic eligibility from `lastRunAt + intervalSeconds`.
`GEODATA_IMPORTER_ENABLED` keeps it opt-in. Deployment,
live-source qualification, remaining review workflows, and outage/recovery
evidence are outstanding.
Complete snapshot imports are also accepted on the ordinary import path; the
worker applies disappearance policy after the final batch is staged, before
candidate review or promotion, matching the reference worker lifecycle.
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
Proposal idempotency scopes keys by owner and route, fingerprints the parsed
request body before validation, and rejects changed-body reuse while preserving
integer versus float values. The request lock spans proposal validation and
import, source-object, and outbox creation.
Candidate validation notes are stored as JSONB with existing text values
preserved as JSON strings. If-Match protected name, website,
description, geometry, and
category and location edits are also implemented; other review
workflows remain outstanding.

## User applications

| Application     | Required parity                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin web       | Login and role-aware navigation; account and role management; programme/category/content/policy administration; Geodata catalogue, import, preprocessing, review, entity editing, maps and deletion; Activity/QSO and award administration; observability access. Preserve accessible keyboard workflows, confirmation of destructive actions, conflict handling, bounded paging, resumable upload behavior, and accurate loading/error states. |
| Participant web | Programme selection, public programme content and rules, approved/candidate entity table and map, candidate proposal, authenticated profile editing and cropped profile-image upload, published award/level display and request, activation creation, QSO entry, and activation close. Keep programme policy, callsign authorization, and eligibility decisions on owning services.                                                             |

The baseline Admin and Participant applications are carried forward under
`web/` with separate deployment artifacts. The Admin build is checked in CI;
a static source scan resolves 62 concrete Admin HTTP method/path pairs, all
present in the OpenAPI contract. This does not establish payload or workflow
parity. The Participant client includes localized published programme content,
paged approved/candidate entity catalogue and map, map-picked point proposals and existing-candidate proposals, published award and level catalogue with eligible-level requests, activation creation,
single-QSO entry, profile editing and image management, but those workflows lack
browser-level compatibility coverage. The award catalogue follows all API pages.
Remaining work
includes accessibility/visual review and deployment integration. Its public
map renders point, line, polygon, and multipart entity geometries.

## Workers and operations

- Activity workers: QSO ingestion, ADIF processing, award evaluation and
  recalculation, certificate rendering, and statistics rebuild are consumed
  from their registered JetStream durables. Database leases and message
  progress acknowledgements protect long jobs; notifications are handled by
  the separate consumer described below. ADIF source-object retention is
  scheduled, and queued jobs missing an outbox command are repaired periodically;
  other retention and recovery evidence remain open.
- Identity maintenance: expired recovery tokens, revoked sessions, expired
  revocations, rate-limit windows, old security events, and aged orphan profile
  images are cleaned by a separate Core-owned worker.
- Activity notification consumption: exact durable validation, transactional
  processed-event/checkpoint and notification writes, deduplication, bounded
  retry, redacted poison-event dead-lettering, and audited CLI redrive are
  implemented, with outcome and unresolved-dead-letter metrics. Recovery
  evidence remains open.
- Geodata workers: registered JetStream consumers for import preprocessing and
  promotion, confirmed entity deletion, and location enrichment are implemented.
  `/healthz` and `/readyz` expose liveness and Geodata PostgreSQL/NATS
  readiness. Stale queued and expired work is re-enqueued through the owner outbox.
  Scheduled import and upload-session retention is implemented; outage/recovery
  evidence remains open.
- Gateway: routes public API requests to their owning services, protects
  Identity internal endpoints, streams request and response bodies, enforces
  configured proxy timeouts, and resolves Grafana identity and permissions from
  the live Identity service. Gateway request counters are exposed at `/metrics`.
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
  service/worker deployment units.

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
