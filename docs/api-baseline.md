# HTTP API baseline

The reference is `myota-platform/myota` at commit
[`7f904a5130e59006765cf882956a4adbfecb17ec`](https://github.com/myota-platform/myota/tree/7f904a5130e59006765cf882956a4adbfecb17ec).
This immutable snapshot, captured from the repository's `testing` branch, is the
function-parity baseline for this implementation. Do not silently replace it with a
moving branch head; changing the baseline requires a reviewed contract and behavior
update.

The exact reference contract files are now preserved locally in
[`contracts/reference/`](../contracts/reference/). Its `openapi.yaml` has SHA-256
`af9b9bd81c723f040ae3ddd407992cb53c89c18a6fbd4f5e147fa0df27025eba` and defines 135
operations across 113 paths. The target
[`contracts/openapi.yaml`](../contracts/openapi.yaml) contains that baseline plus six
target-only operations, for 141 operations across 119 paths. The table below inventories
the target contract; the added operations are extensions, not upstream OpenAPI parity
requirements, and need separate evidence against current source behavior.

The target also edits eight shared operation definitions:

- `GET /v1/identity/admin/security-events`, `GET /v1/identity/accounts/{accountId}/export`,
  and `POST /v1/identity/auth/service-token` add operation IDs.
- `POST /v1/geodata/refresh-schedules/{scheduleId}/run` documents the required
  `features` input that the reference handler enforces.
- `POST /v1/geodata/imports/{runId}/process` clarifies which failed-queue
  candidates can be retried.
- `GET /v1/geodata/entities` documents that legacy individual bounds take
  precedence over `bbox` when any individual bound is supplied, matching the
  current reference handler.
- `POST /v1/geodata/proposals` documents optional attachment metadata accepted
  by the Python handler and preserved on the proposed entity.
- `POST /v1/identity/oidc/providers` declares `201`, while the upstream
  OpenAPI declares `200`. The pinned Python handler and NestJS handler both
  return `201`; the target contract follows the executable reference behavior.
  The upstream OpenAPI response remains recorded in the preserved reference
  contract.

Target-only operations:

- `POST /v1/activity/work-jobs/{jobId}/redrive`
- `POST /v1/adif/imports`
- `POST /v1/geodata/imports/{runId}/processing-queues/{queueId}/redrive`
- `POST /v1/qso-ingestions/csv`
- `GET /v1/public/programmes/{slug}/content`
- `GET /v1/qso-corrections`

OpenAPI 3.1.0; 141 operations across 119 paths.

Every operation below has a matching NestJS route decorator. The controller link is route-level traceability only; behavioral parity still requires the checks described in the parity matrix.

## Identity

- `POST /v1/identity/auth/register` — Disabled until email verification and registration abuse controls are deployed (route owner [controller](../apps/identity/src/auth.controller.ts))
- `POST /v1/identity/auth/login` — Authenticate with email and password (route owner [controller](../apps/identity/src/auth.controller.ts))
- `POST /v1/identity/auth/refresh` — Rotate a refresh token (route owner [controller](../apps/identity/src/auth.controller.ts))
- `POST /v1/identity/auth/logout` — Revoke a session or access token (route owner [controller](../apps/identity/src/auth.controller.ts))
- `POST /v1/identity/auth/recovery/request` — Request password recovery without disclosing account existence (route owner [controller](../apps/identity/src/auth.controller.ts))
- `POST /v1/identity/auth/recovery/reset` — Set a new password using a single-use recovery token (route owner [controller](../apps/identity/src/auth.controller.ts))
- `GET /v1/identity/me` — Get the authenticated account and scopes (route owner [controller](../apps/identity/src/auth.controller.ts))
- `PATCH /v1/identity/me/profile` — Update the authenticated account's private profile fields (route owner [controller](../apps/identity/src/auth.controller.ts); operation ID `patchIdentityProfile`)
- `GET /v1/identity/me/profile-image` — Read the authenticated account's private profile image (route owner [controller](../apps/identity/src/auth.controller.ts); operation ID `getIdentityProfileImage`)
- `PUT /v1/identity/me/profile-image` — Upload or replace the authenticated account's profile image (route owner [controller](../apps/identity/src/auth.controller.ts); operation ID `putIdentityProfileImage`)
- `DELETE /v1/identity/me/profile-image` — Remove the authenticated account's profile image (route owner [controller](../apps/identity/src/auth.controller.ts); operation ID `deleteIdentityProfileImage`)
- `GET /v1/identity/accounts/{accountId}/profile-image` — Read an account profile image as the owner or an Identity administrator (route owner [controller](../apps/identity/src/auth.controller.ts); operation ID `getAccountProfileImage`)
- `GET /v1/identity/admin/accounts` — List accounts for global identity administrators (route owner [controller](../apps/identity/src/auth.controller.ts))
- `GET /v1/identity/admin/roles` — List built-in and custom administrative roles and permissions (route owner [controller](../apps/identity/src/auth.controller.ts))
- `POST /v1/identity/admin/roles` — Create a custom administrative role (route owner [controller](../apps/identity/src/auth.controller.ts))
- `POST /v1/identity/roles` — Create a custom administrative role (route owner [controller](../apps/identity/src/auth.controller.ts); operation ID `createIdentityRole`)
- `GET /v1/identity/admin/security-events` — List security events for global identity administrators (route owner [controller](../apps/identity/src/auth.controller.ts); operation ID `listSecurityEvents`)
- `POST /v1/identity/accounts` — Create a participant account; role grants require separate authority (route owner [controller](../apps/identity/src/auth.controller.ts); operation ID `createAccount`)
- `POST /v1/identity/accounts/{accountId}/callsigns` — Add and optionally verify a callsign (route owner [controller](../apps/identity/src/auth.controller.ts))
- `POST /v1/identity/accounts/{accountId}/callsigns/{callsignId}/evidence` — Submit callsign verification evidence (route owner [controller](../apps/identity/src/auth.controller.ts))
- `POST /v1/identity/accounts/{accountId}/callsigns/{callsignId}/verify` — Verify callsign evidence using the callsign.verify scope (route owner [controller](../apps/identity/src/auth.controller.ts))
- `GET /v1/identity/accounts/{accountId}/roles` — (route owner [controller](../apps/identity/src/auth.controller.ts))
- `GET /v1/identity/accounts/{accountId}/export` — Export an account's personal data (route owner [controller](../apps/identity/src/auth.controller.ts); operation ID `exportAccount`)
- `POST /v1/identity/auth/service-token` — Issue a short-lived service token for an authorised integration (route owner [controller](../apps/identity/src/auth.controller.ts); operation ID `issueServiceToken`)
- `GET /v1/identity/internal/email-recipients/{accountId}` — Resolve a deliverable email address for the email service (route owner [controller](../apps/identity/src/auth.controller.ts); operation ID `getEmailRecipientAddress`)
- `GET /v1/identity/accounts/{accountId}` — Get an account by identifier (route owner [controller](../apps/identity/src/auth.controller.ts))
- `PATCH /v1/identity/accounts/{accountId}` — Partially update an account and optionally replace its active administrative roles (route owner [controller](../apps/identity/src/auth.controller.ts); operation ID `patchIdentityAccount`)
- `PATCH /v1/identity/roles/{roleCode}` — Partially update a custom administrative role (route owner [controller](../apps/identity/src/auth.controller.ts); operation ID `patchIdentityRole`)
- `PUT /v1/identity/accounts/{accountId}/role-assignments` — Replace an account's active administrative role assignments (route owner [controller](../apps/identity/src/auth.controller.ts); operation ID `replaceAccountRoleAssignments`)
- `PUT /v1/identity/accounts/{accountId}/primary-callsign` — Replace an account's primary callsign (route owner [controller](../apps/identity/src/auth.controller.ts); operation ID `setPrimaryCallsign`)
- `POST /v1/identity/accounts/{accountId}/callsigns/{callsignId}/retire` — Retire a callsign association (route owner [controller](../apps/identity/src/auth.controller.ts))
- `POST /v1/identity/oidc/providers` — Register a programme-scoped OIDC provider mapping (route owner [controller](../apps/identity/src/auth.controller.ts); operation ID `saveOidcMapping`)

## Programmes

- `GET /v1/programmes` — List configured programmes (route owner [controller](../apps/programmes/src/programmes.controller.ts))
- `POST /v1/programmes` — Create a programme configuration (route owner [controller](../apps/programmes/src/programmes.controller.ts))
- `GET /v1/programmes/{slug}/policy` — Get the effective programme policy version (route owner [controller](../apps/programmes/src/programmes.controller.ts))
- `GET /v1/entity-types` — List shared entity category master data (route owner [controller](../apps/programmes/src/entity-types.controller.ts))
- `POST /v1/entity-types` — Create or update a shared entity category definition (route owner [controller](../apps/programmes/src/entity-types.controller.ts))
- `GET /v1/programmes/{slug}/entity-types` — List entity categories assigned to the programme (route owner [controller](../apps/programmes/src/entity-types.controller.ts))
- `POST /v1/programmes/{slug}/entity-types` — Legacy category upsert and assignment compatibility endpoint (route owner [controller](../apps/programmes/src/entity-types.controller.ts))
- `GET /v1/programmes/{slug}` — Get a programme configuration (route owner [controller](../apps/programmes/src/programmes.controller.ts))
- `PATCH /v1/programmes/{slug}` — Partially update a programme configuration or archive it (route owner [controller](../apps/programmes/src/programmes.controller.ts); operation ID `patchProgramme`)
- `PUT /v1/programmes/{slug}/entity-types/{categoryCode}` — Idempotently assign an entity category to a programme (route owner [controller](../apps/programmes/src/entity-types.controller.ts); operation ID `assignProgrammeEntityCategory`)
- `DELETE /v1/programmes/{slug}/entity-types/{categoryCode}` — Idempotently remove an entity category from a programme (route owner [controller](../apps/programmes/src/entity-types.controller.ts); operation ID `unassignProgrammeEntityCategory`)
- `GET /v1/programmes/{slug}/content` — List programme-owned content versions (route owner [controller](../apps/programmes/src/programme-content.controller.ts))
- `POST /v1/programmes/{slug}/content` — Create or update a draft content version (route owner [controller](../apps/programmes/src/programme-content.controller.ts))
- `GET /v1/programmes/{slug}/content/coverage` — Report programme content locale coverage (route owner [controller](../apps/programmes/src/programme-content.controller.ts))
- `POST /v1/programmes/{slug}/content/{contentId}/submit` — Submit content for review (route owner [controller](../apps/programmes/src/programme-content.controller.ts))
- `POST /v1/programmes/{slug}/content/{contentId}/review` — Review programme content (route owner [controller](../apps/programmes/src/programme-content.controller.ts))
- `POST /v1/programmes/{slug}/content/{contentId}/publish` — Publish programme content (route owner [controller](../apps/programmes/src/programme-content.controller.ts))
- `PATCH /v1/programmes/{slug}/content/{contentId}` — Update content or advance its draft lifecycle (route owner [controller](../apps/programmes/src/programme-content.controller.ts); operation ID `patchProgrammeContent`)
- `GET /v1/programmes/{slug}/policy-drafts` — List programme policy drafts (route owner [controller](../apps/programmes/src/programme-policy.controller.ts))
- `POST /v1/programmes/{slug}/policy-drafts` — Create or update a programme policy draft (route owner [controller](../apps/programmes/src/programme-policy.controller.ts))
- `POST /v1/programmes/{slug}/policy-drafts/{draftId}/submit` — Submit a policy draft for review (route owner [controller](../apps/programmes/src/programme-policy.controller.ts))
- `POST /v1/programmes/{slug}/policy-drafts/{draftId}/review` — Review a policy draft (route owner [controller](../apps/programmes/src/programme-policy.controller.ts))
- `POST /v1/programmes/{slug}/policy-drafts/{draftId}/publish` — Publish a policy draft (route owner [controller](../apps/programmes/src/programme-policy.controller.ts))
- `PATCH /v1/programmes/{slug}/policy-drafts/{draftId}` — Update a policy draft or advance its lifecycle (route owner [controller](../apps/programmes/src/programme-policy.controller.ts); operation ID `patchProgrammePolicyDraft`)

## Geodata

- `GET /v1/geodata/entities` — List verified and candidate entities (route owner [controller](../apps/geodata/src/geodata.controller.ts))
- `GET /v1/geodata/imports` — List geodata import runs (route owner [controller](../apps/geodata/src/geodata.controller.ts))
- `POST /v1/geodata/imports` — Create a geodata import resource and queue candidate preprocessing (route owner [controller](../apps/geodata/src/geodata.controller.ts))
- `GET /v1/geodata/imports/{runId}` — Get geodata import status and summary (route owner [controller](../apps/geodata/src/geodata.controller.ts))
- `PUT /v1/geodata/imports/{runId}/cancellation` — Cancel a queued upload or request cancellation of active preprocessing (route owner [controller](../apps/geodata/src/geodata.controller.ts))
- `GET /v1/geodata/imports/{runId}/candidates` — List the paged pre-processed records for an import run (route owner [controller](../apps/geodata/src/geodata.controller.ts))
- `POST /v1/geodata/imports/{runId}/candidates/validate` — Confirm or reject selected pre-processed records for promotion (route owner [controller](../apps/geodata/src/geodata.controller.ts))
- `POST /v1/geodata/imports/{runId}/process` — Queue selected records for entity promotion (route owner [controller](../apps/geodata/src/geodata.controller.ts))
- `GET /v1/geodata/imports/{runId}/processing-queues/{queueId}` — Read the outcome of an import promotion queue (route owner [controller](../apps/geodata/src/geodata.controller.ts))
- `POST /v1/geodata/imports/{runId}/processing-queues/{queueId}/redrive` — Redrive a failed import promotion queue (route owner [controller](../apps/geodata/src/geodata.controller.ts))
- `POST /v1/geodata/imports/{runId}/processed` — Finalize an import and discard staged records (route owner [controller](../apps/geodata/src/geodata.controller.ts))
- `DELETE /v1/geodata/load-test-runs/{testRunId}` — Clean up a tagged geodata load-test run (route owner [controller](../apps/geodata/src/geodata.controller.ts); operation ID `deleteGeodataLoadTestRun`)
- `POST /v1/geodata/import-uploads` — Create a restart-safe resumable geodata upload (route owner [controller](../apps/geodata/src/geodata.controller.ts))
- `GET /v1/geodata/import-uploads/{uploadId}` — Inspect an owned upload session and its received parts (route owner [controller](../apps/geodata/src/geodata.controller.ts))
- `DELETE /v1/geodata/import-uploads/{uploadId}` — Abort an owned incomplete upload session (route owner [controller](../apps/geodata/src/geodata.controller.ts))
- `POST /v1/geodata/import-uploads/{uploadId}/parts/{partNumber}` — Upload or retry one bounded binary part (route owner [controller](../apps/geodata/src/geodata.controller.ts))
- `POST /v1/geodata/import-uploads/{uploadId}/complete` — Verify and complete an upload, then durably enqueue preprocessing (route owner [controller](../apps/geodata/src/geodata.controller.ts))
- `GET /v1/geodata/location-options` — List provider-derived location hierarchy options (route owner [controller](../apps/geodata/src/geodata.controller.ts))
- `GET /v1/geodata/adapters` — List supported geodata import adapters and formats (route owner [controller](../apps/geodata/src/geodata.controller.ts))
- `GET /v1/geodata/entities/{entityId}` — Get a geodata entity (route owner [controller](../apps/geodata/src/geodata.controller.ts))
- `PATCH /v1/geodata/entities/{entityId}` — Update editable entity metadata (route owner [controller](../apps/geodata/src/geodata.controller.ts); operation ID `patchGeodataEntityMetadata`)
- `GET /v1/geodata/entities/{entityId}/audit` — Get entity review, geometry, and lifecycle audit context (route owner [controller](../apps/geodata/src/geodata.controller.ts))
- `POST /v1/geodata/entities/{entityId}/location-enrichment-requests` — Queue reverse-geocoding for missing entity location metadata (route owner [controller](../apps/geodata/src/geodata.controller.ts); operation ID `postGeodataEntityLocationEnrichmentRequest`)
- `GET /v1/geodata/tiles/{z}/{x}/{y}` — Get a GeoJSON vector collection for a Web Mercator tile (route owner [controller](../apps/geodata/src/geodata.controller.ts))
- `GET /v1/geodata/refresh-schedules` — List geodata refresh schedules (route owner [controller](../apps/geodata/src/geodata.controller.ts))
- `POST /v1/geodata/refresh-schedules` — Create a geodata refresh schedule (route owner [controller](../apps/geodata/src/geodata.controller.ts))
- `POST /v1/geodata/refresh-schedules/{scheduleId}/run` — Run a geodata refresh schedule (route owner [controller](../apps/geodata/src/geodata.controller.ts))
- `POST /v1/geodata/proposals` — Submit a community proposal for candidate promotion (route owner [controller](../apps/geodata/src/geodata.controller.ts); operation ID `postGeodataProposal`)
- `GET /v1/geodata/conflation` — List open geodata conflation candidates (route owner [controller](../apps/geodata/src/geodata.controller.ts))
- `POST /v1/geodata/conflation/{candidateId}/resolve` — Resolve a geodata conflation candidate (route owner [controller](../apps/geodata/src/geodata.controller.ts))
- `PUT /v1/geodata/entities/{entityId}/geometry` — Replace an entity geometry with validated GeoJSON (route owner [controller](../apps/geodata/src/geodata.controller.ts); operation ID `putGeodataEntityGeometry`)
- `PUT /v1/geodata/entities/{entityId}/categories` — Replace an entity's shared category assignments (route owner [controller](../apps/geodata/src/geodata.controller.ts); operation ID `putGeodataEntityCategories`)
- `POST /v1/geodata/entities/{entityId}/reviews` — Record an entity lifecycle review decision (route owner [controller](../apps/geodata/src/geodata.controller.ts); operation ID `postGeodataEntityReview`)
- `POST /v1/geodata/entity-deletion-jobs` — Create an entity deletion impact and confirmation job (route owner [controller](../apps/geodata/src/geodata.controller.ts); operation ID `createGeodataEntityDeletionJob`)
- `GET /v1/geodata/entity-deletion-jobs/{jobId}` — Get an entity deletion job (route owner [controller](../apps/geodata/src/geodata.controller.ts); operation ID `getGeodataEntityDeletionJob`)
- `POST /v1/geodata/entity-deletion-jobs/{jobId}/confirm` — Confirm and queue entity deletion (route owner [controller](../apps/geodata/src/geodata.controller.ts); operation ID `confirmGeodataEntityDeletionJob`)

## Activity

- `GET /v1/activations/entity-deletion-impacts/{entityId}` — Read the activity impact of deleting an entity (route owner [controller](../apps/activity/src/activity.controller.ts); operation ID `getEntityDeletionImpact`)
- `POST /v1/activations/entity-deletion-cascades` — Create the activity cascade for an approved geodata deletion job (route owner [controller](../apps/activity/src/activity.controller.ts); operation ID `cascadeEntityDeletion`)
- `GET /v1/activations` — List activations for authorised operators and administrators (route owner [controller](../apps/activity/src/activity.controller.ts))
- `POST /v1/activations` — Start an activation (route owner [controller](../apps/activity/src/activity.controller.ts))
- `GET /v1/activations/{activationId}` — Get an activation and its normalized QSOs (route owner [controller](../apps/activity/src/activity.controller.ts))
- `PATCH /v1/activations/{activationId}` — Update an activation lifecycle state (route owner [controller](../apps/activity/src/activity.controller.ts); operation ID `patchActivation`)
- `POST /v1/activations/{activationId}/qsos` — Record a normalized QSO for an open activation (route owner [controller](../apps/activity/src/activity.controller.ts))
- `GET /v1/awards` — List programme-owned award definitions (route owner [controller](../apps/activity/src/awards.controller.ts))
- `POST /v1/awards` — Save a draft programme-owned award definition (route owner [controller](../apps/activity/src/awards.controller.ts))
- `GET /v1/awards/{awardId}` — Get an award definition (route owner [controller](../apps/activity/src/awards.controller.ts))
- `PATCH /v1/awards/{awardId}` — Update an award or advance its draft lifecycle (route owner [controller](../apps/activity/src/awards.controller.ts); operation ID `patchAward`)
- `POST /v1/awards/{awardId}/submit` — Submit an award definition for review (route owner [controller](../apps/activity/src/awards.controller.ts))
- `POST /v1/awards/{awardId}/review` — Approve or return an award definition for changes (route owner [controller](../apps/activity/src/awards.controller.ts))
- `POST /v1/awards/{awardId}/publish` — Publish an approved award with an effective date (route owner [controller](../apps/activity/src/awards.controller.ts))
- `GET /v1/awards/assets` — List registered background and signature assets (route owner [controller](../apps/activity/src/awards.controller.ts))
- `POST /v1/awards/assets` — Register an image asset stored in S3-compatible object storage (route owner [controller](../apps/activity/src/awards.controller.ts))
- `GET /v1/awards/assets/{assetId}/content` — Read bounded registered PNG/JPEG content for authenticated design (route owner [controller](../apps/activity/src/awards.controller.ts); operation ID `getAwardAssetContent`)
- `PUT /v1/awards/assets/{assetId}/content` — Store and validate registered PNG/JPEG artwork through the API (route owner [controller](../apps/activity/src/awards.controller.ts); operation ID `putAwardAssetContent`)
- `POST /v1/awards/previews` — Render an unsaved certificate design with mock data without issuance or storage (route owner [controller](../apps/activity/src/awards.controller.ts); operation ID `createAwardPreview`)
- `POST /v1/awards/evaluation-jobs` — Queue award condition evaluation (route owner [controller](../apps/activity/src/awards.controller.ts); operation ID `createAwardEvaluationJob`)
- `GET /v1/awards/evaluation-jobs/{jobId}` — Get award evaluation job status (route owner [controller](../apps/activity/src/awards.controller.ts); operation ID `getAwardEvaluationJob`)
- `GET /v1/awards/progress` — Get award progress for a participant (route owner [controller](../apps/activity/src/awards.controller.ts); operation ID `getAwardProgress`)
- `GET /v1/awards/requests` — List award requests (route owner [controller](../apps/activity/src/awards.controller.ts))
- `POST /v1/awards/requests` — Request an eligible award level (route owner [controller](../apps/activity/src/awards.controller.ts))
- `POST /v1/awards/requests/{requestId}/issuances` — Create a permanent award issuance (route owner [controller](../apps/activity/src/awards.controller.ts); operation ID `createAwardIssuance`)
- `GET /v1/awards/issuances` — List permanent award issuance records (route owner [controller](../apps/activity/src/awards.controller.ts))
- `POST /v1/awards/issuances/{issuanceId}/render-jobs` — Queue certificate rendering (route owner [controller](../apps/activity/src/awards.controller.ts); operation ID `createCertificateRenderJob`)
- `GET /v1/awards/issuances/{issuanceId}/render-jobs/{jobId}` — Get certificate render job status (route owner [controller](../apps/activity/src/awards.controller.ts); operation ID `getCertificateRenderJob`)
- `GET /v1/awards/issuances/{issuanceId}/artifact` — Get the issued certificate artifact (route owner [controller](../apps/activity/src/awards.controller.ts); operation ID `getAwardArtifact`)
- `POST /v1/qso-ingestions` — Queue a high-volume normalized QSO ingestion (route owner [controller](../apps/activity/src/qso-ingestion.controller.ts); operation ID `createQsoIngestion`)
- `POST /v1/qso-ingestions/csv` — Upload and queue a CSV QSO log for an activation (route owner [controller](../apps/activity/src/qso-ingestion.controller.ts); operation ID `createCsvQsoIngestion`)
- `GET /v1/qso-ingestions/{ingestionId}` — Get QSO ingestion job status (route owner [controller](../apps/activity/src/qso-ingestion.controller.ts); operation ID `getQsoIngestion`)
- `POST /v1/adif/imports` — Upload and queue an ADIF log for an activation (route owner [controller](../apps/activity/src/adif-import.controller.ts); operation ID `createAdifImport`)
- `GET /v1/adif/imports/{importId}` — Get ADIF import status (route owner [controller](../apps/activity/src/adif-import.controller.ts))
- `POST /v1/activity/work-jobs/{jobId}/redrive` — Redrive a failed or recoverable Activity work job (route owner [controller](../apps/activity/src/activity-operations.controller.ts))
- `POST /v1/qsos/{qsoId}/corrections` — Request a QSO correction (route owner [controller](../apps/activity/src/qso-correction.controller.ts))
- `POST /v1/qsos/{qsoId}/corrections/{correctionId}/review` — Review a QSO correction under its QSO resource (route owner [controller](../apps/activity/src/qso-correction.controller.ts); operation ID `reviewQsoCorrection`)
- `GET /v1/qso-corrections` — List and page QSO correction requests for Activity administrators (route owner [controller](../apps/activity/src/qso-admin.controller.ts); operation ID `listQsoCorrections`)
- `POST /v1/statistics/rebuild-jobs` — Create a reproducible activity statistics rebuild job (route owner [controller](../apps/activity/src/activity-operations.controller.ts); operation ID `createStatisticsRebuildJob`)
- `GET /v1/statistics/rebuild-jobs/{jobId}` — Get statistics rebuild job status (route owner [controller](../apps/activity/src/activity-operations.controller.ts); operation ID `getStatisticsRebuildJob`)
- `GET /v1/statistics` — List precomputed activity statistics (route owner [controller](../apps/activity/src/activity-operations.controller.ts))
- `GET /v1/notifications` — List notifications for the authenticated account (route owner [controller](../apps/activity/src/activity-operations.controller.ts))
- `POST /v1/awards/{awardId}/recalculation-jobs` — Queue historical award progress recalculation (route owner [controller](../apps/activity/src/awards.controller.ts); operation ID `createAwardRecalculationJob`)
- `GET /v1/awards/{awardId}/recalculation-jobs/{jobId}` — Get award recalculation job status (route owner [controller](../apps/activity/src/awards.controller.ts); operation ID `getAwardRecalculationJob`)
- `POST /v1/awards/{awardId}/retire` — Retire an award definition (route owner [controller](../apps/activity/src/awards.controller.ts))

## Public programme APIs

- `GET /v1/public/programmes/{slug}/content` — Get effective published programme content (route owner [module](../apps/programmes/src/programmes.module.ts); operation ID `getPublishedProgrammeContent`)
- `GET /v1/public/activations` — List public activation history (route owner [controller](../apps/activity/src/public-activity.controller.ts))
- `GET /v1/public/leaderboards` — List public programme leaderboards (route owner [controller](../apps/activity/src/public-activity.controller.ts))
- `GET /v1/public/results` — Download public activation results (route owner [controller](../apps/activity/src/public-activity.controller.ts))
