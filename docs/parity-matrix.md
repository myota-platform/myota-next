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
anonymization, and role replacement behavior in Core transactions.
These are the first implemented slices; they still need automated
compatibility coverage before they count as parity complete.

## User applications

| Application     | Required parity                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin web       | Login and role-aware navigation; account and role management; programme/category/content/policy administration; Geodata catalogue, import, preprocessing, review, entity editing, maps and deletion; Activity/QSO and award administration; observability access. Preserve accessible keyboard workflows, confirmation of destructive actions, conflict handling, bounded paging, resumable upload behavior, and accurate loading/error states. |
| Participant web | Programme selection, public programme content and rules, approved/candidate entity table and map, candidate proposal, authenticated profile editing and cropped profile-image upload, published award/level display, award login and award request. The current static app does not expose activation or QSO entry workflows. Keep programme policy and eligibility decisions on owning services.                                               |

## Workers and operations

- Activity workers: QSO ingestion, ADIF processing, award evaluation and
  recalculation, certificate rendering, statistics rebuild, notifications,
  and retention/recovery tasks.
- Geodata workers: import preprocessing and promotion, confirmed entity
  deletion, location enrichment, retention, and recovery tasks.
- Gateway: preserve routing, upload limits/timeouts, authentication context,
  and protected observability proxy behavior.
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
