# Function parity matrix

This is the acceptance inventory for the new implementation. The copied
`contracts/openapi.yaml` and event schemas are the first compatibility
baseline. Current implementation reference:
[`myota`](https://github.com/myota-platform/myota/tree/7f904a5130e59006765cf882956a4adbfecb17ec).

## Domain functions

| Area           | Required parity                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity       | Preserve the intentionally disabled public-registration response; login, refresh, logout, recovery, current profile and profile images; account creation and administration; role definition and assignment; callsign creation, evidence, verification, primary selection and retirement; OIDC mapping; service tokens; account export/deactivation; security events; authorization scopes and abuse controls.    |
| Programmes     | Programme create/read/update/archive; shared category catalog and programme assignments; programme content and policy draft lifecycle (save, submit, review, publish); configuration coverage and theme/content delivery.                                                                                                                                                                                         |
| Geodata        | Catalog search, paging, bounding box and tiles; source adapters; pasted imports and resumable multipart uploads; validation/preprocessing queues, duplicate warnings and promotion; provenance, audit, review and lifecycle; metadata, categories, geometry and location edits; asynchronous location enrichment; refresh schedules; conflation; authorized deletion with Activity impact calculation; retention. |
| Activity       | Activation lifecycle; single and batch QSO writes; ADIF and QSO ingestion; correction requests and review; public history, results, leaderboards and statistics; statistics rebuild; award design and lifecycle; conditions, levels, evaluation and progress; requests, issuance, assets, previews, certificate rendering and artifact retrieval; notification records and authorized operational views.          |
| Email delivery | Keep the existing email worker behavior and `email.send.v1` contract visible in the parity inventory. The current registry marks the Identity producer and runtime deployment as gated; do not claim or enable end-to-end delivery until its provider, secrets, retry behavior, and deployment are explicitly qualified.                                                                                          |

Identity currently implements disabled public registration, password login,
refresh rotation, logout revocation, recovery request/reset, current-account
reads, owner-only profile updates, account creation, and administrator account
listing, owner/global account reads and account role reads in NestJS. The role catalogue endpoint returns built-in and persisted
custom roles under the existing authorized scopes; custom role creation and
partial updates are backed by Core transactions and security/outbox events.
Administrative account updates now preserve profile, password, status,
anonymization, and role replacement behavior in Core transactions. Callsign
creation, evidence, verification, primary selection, and retirement also write
to the relational Core model and outbox.
These are the first implemented slices; they still need automated
compatibility coverage before they count as parity complete.

Activity has an initial activation and single-QSO slice: activation list/create/read/close,
normalized QSO writes, validity checks, ownership checks, subject aggregates,
transactional event outbox records, idempotency responses, and award recalculation
jobs. QSO ingestion requests also persist bounded, owner-scoped jobs with a status
read path, and the separate Activity worker processes those jobs with database
leases, retries, and dead-letter state. NATS delivery and other Activity consumers
remain outstanding. QSO correction requests and administrator review are also
implemented, with applied changes queuing recalculation. Award definition draft,
review, publish, and retire APIs are implemented. Award progress reads and
evaluation/recalculation job APIs persist versioned progress and qualification
notifications through the Activity worker. Award requests validate eligibility,
issuance is transactional and permanent, and PDF render jobs store artifacts in
S3-compatible storage with authorized presigned download URLs. Registered award
assets and bounded content storage are implemented. ADIF uploads now pass
authorization, malware checks, and object storage before durable queueing; the
Activity worker parses records, records successes and rejects, updates
aggregates, and reports import status. CSV file uploads now validate bounded
UTF-8 input and queue normalized rows through the same ingestion job. Remaining
Activity work includes notification production beyond qualification and NATS
delivery. Failed or queued Activity jobs can be redriven by administrators with
an audited reason; long-running Activity jobs now extend their 120-second leases
from a separate database connection while processing. Statistics listing and rebuild-job APIs,
transactional snapshot rebuilds, and owner-scoped notification reads are
implemented. ADIF import creation, processing, and status reads are implemented.
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
JSON GeoJSON import creation stores source documents in S3-compatible storage
and queues idempotent import runs transactionally. The worker validates feature
names and WGS84 geometries, stages candidates with provenance and 50 m duplicate
warnings, records errors, and emits the preprocessing fact. Community proposals
join this pipeline and automatically queue promotion to CANDIDATE. Multipart/resumable
uploads are implemented with owner-scoped durable sessions, bounded binary
parts, checksum and malware scanning, and transactional completion up to the
worker's 20 MiB GeoJSON limit. Durable object references from the configured
import bucket are bounded, hash-checked, validated, and staged as normalized
worker inputs. Refresh schedules can be listed and created, and manual complete-
snapshot runs queue GeoJSON imports, promote validated candidates, record
manifests, and apply disappearance policy after successful promotion.
Import promotion generates deduplicated conflation candidates from overlapping
PostGIS bounding boxes using the baseline 0.55 scoring threshold. Failed
promotion queues can be redriven with a required reason recorded in queue
metadata and the outbox. Automatic scheduled execution, remaining review
workflows, NATS delivery, and remaining worker operations are outstanding.
Finalization removes staged candidates and queues transactionally
while preserving the import summary and materialized entities. Pending
candidates can be paged; administrators can confirm or
reject selected rows transactionally. Selected candidates can also be queued
for CANDIDATE or scope-gated APPROVED promotion; the worker persists entities,
category and source links, audit/outbox events, and queue outcomes. Lifecycle
review and If-Match protected name, website, description, geometry, and
category and location edits are also implemented; other review
workflows remain outstanding.

## User applications

| Application     | Required parity                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin web       | Login and role-aware navigation; account and role management; programme/category/content/policy administration; Geodata catalogue, import, preprocessing, review, entity editing, maps and deletion; Activity/QSO and award administration; observability access. Preserve accessible keyboard workflows, confirmation of destructive actions, conflict handling, bounded paging, resumable upload behavior, and accurate loading/error states. |
| Participant web | Programme selection, public programme content and rules, approved/candidate entity table and map, candidate proposal, authenticated profile editing and cropped profile-image upload, published award/level display, award login and award request. The current static app does not expose activation or QSO entry workflows. Keep programme policy and eligibility decisions on owning services.                                               |

## Workers and operations

- Activity workers: QSO ingestion, ADIF processing, award evaluation and
  recalculation, certificate rendering, and statistics rebuild are consumed
  from their registered JetStream durables. Database leases and message
  progress acknowledgements protect long jobs; notifications are handled by
  the separate consumer described below. Retention/recovery tasks remain open.
- Activity notification consumption: exact durable validation, transactional
  processed-event/checkpoint and notification writes, deduplication, bounded
  retry, redacted poison-event dead-lettering, and audited CLI redrive are
  implemented, with outcome and unresolved-dead-letter metrics. Recovery
  evidence remains open.
- Geodata workers: registered JetStream consumers for import preprocessing and
  promotion, confirmed entity deletion, and location enrichment are implemented.
  Stale queued and expired work is re-enqueued through the owner outbox.
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
  Operational recovery evidence is not complete yet.
- Runtime: preserve migrations, health/readiness, metrics, logs, traces,
  backups, restore paths, NATS topology, object storage buckets, and separate
  service/worker deployment units.

## Compatibility and completion evidence

Parity is complete only when every current OpenAPI operation and registered
event is mapped to an implementation and automated compatibility check, and
when user workflows and worker behavior have equivalent tests. The copied
event registry currently contains 68 fact schemas and 11 work-command schemas.
Checks must
cover success, authorization, validation, conflicts, persistence, retries,
redelivery, idempotency, and failure recovery where relevant. UI parity also
requires browser-level workflow coverage. Database parity includes migration
and data-transfer checks for all three database targets.

The inventory must be refined against the current service tests, UI routes,
worker topology, and migration data before each area is declared complete.
Operational and production qualification are separate gates from API-level
parity.
