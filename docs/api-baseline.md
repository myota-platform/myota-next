# HTTP API baseline

The reference is `myota-platform/myota` at commit
[`7f904a5130e59006765cf882956a4adbfecb17ec`](https://github.com/myota-platform/myota/tree/7f904a5130e59006765cf882956a4adbfecb17ec).
Its `contracts/openapi.yaml` has SHA-256
`af9b9bd81c723f040ae3ddd407992cb53c89c18a6fbd4f5e147fa0df27025eba` and
defines 135 operations across 113 paths. The target
[`contracts/openapi.yaml`](../contracts/openapi.yaml) contains that baseline
plus four target-only operations, for 139 operations across 117 paths. The table
below inventories the target contract; the four added operations are extensions,
not upstream OpenAPI parity requirements, and need separate evidence against
current source behavior.

The target also edits six shared operation definitions:

- `GET /v1/identity/admin/security-events`, `GET /v1/identity/accounts/{accountId}/export`,
  and `POST /v1/identity/auth/service-token` add operation IDs.
- `POST /v1/geodata/refresh-schedules/{scheduleId}/run` documents the required
  `features` input that the reference handler enforces.
- `POST /v1/geodata/imports/{runId}/process` clarifies which failed-queue
  candidates can be retried.
- `POST /v1/identity/oidc/providers` declares `201`, while the upstream
  OpenAPI declares `200`. The reference Python handler returns `201`, and the
  NestJS handler also returns `201`; resolve this contract/runtime discrepancy
  against deployed behavior before treating either response as canonical.

Target-only operations:

- `POST /v1/activity/work-jobs/{jobId}/redrive`
- `POST /v1/adif/imports`
- `POST /v1/geodata/imports/{runId}/processing-queues/{queueId}/redrive`
- `POST /v1/qso-ingestions/csv`

OpenAPI 3.1.0; 139 operations across 117 paths.

| Method | Path                                                              | Operation ID                               | Summary                                                                            |
| ------ | ----------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------- |
| POST   | /v1/identity/auth/register                                        |                                            | Disabled until email verification and registration abuse controls are deployed     |
| POST   | /v1/identity/auth/login                                           |                                            | Authenticate with email and password                                               |
| POST   | /v1/identity/auth/refresh                                         |                                            | Rotate a refresh token                                                             |
| POST   | /v1/identity/auth/logout                                          |                                            | Revoke a session or access token                                                   |
| POST   | /v1/identity/auth/recovery/request                                |                                            | Request password recovery without disclosing account existence                     |
| POST   | /v1/identity/auth/recovery/reset                                  |                                            | Set a new password using a single-use recovery token                               |
| GET    | /v1/identity/me                                                   |                                            | Get the authenticated account and scopes                                           |
| PATCH  | /v1/identity/me/profile                                           | patchIdentityProfile                       | Update the authenticated account's private profile fields                          |
| GET    | /v1/identity/me/profile-image                                     | getIdentityProfileImage                    | Read the authenticated account's private profile image                             |
| PUT    | /v1/identity/me/profile-image                                     | putIdentityProfileImage                    | Upload or replace the authenticated account's profile image                        |
| DELETE | /v1/identity/me/profile-image                                     | deleteIdentityProfileImage                 | Remove the authenticated account's profile image                                   |
| GET    | /v1/identity/accounts/{accountId}/profile-image                   | getAccountProfileImage                     | Read an account profile image as the owner or an Identity administrator            |
| GET    | /v1/identity/admin/accounts                                       |                                            | List accounts for global identity administrators                                   |
| GET    | /v1/identity/admin/roles                                          |                                            | List built-in and custom administrative roles and permissions                      |
| POST   | /v1/identity/admin/roles                                          |                                            | Create a custom administrative role                                                |
| POST   | /v1/identity/roles                                                | createIdentityRole                         | Create a custom administrative role                                                |
| GET    | /v1/identity/admin/security-events                                | listSecurityEvents                         | List security events for global identity administrators                            |
| POST   | /v1/identity/accounts                                             | createAccount                              | Create a participant account; role grants require separate authority               |
| POST   | /v1/identity/accounts/{accountId}/callsigns                       |                                            | Add and optionally verify a callsign                                               |
| POST   | /v1/identity/accounts/{accountId}/callsigns/{callsignId}/evidence |                                            | Submit callsign verification evidence                                              |
| POST   | /v1/identity/accounts/{accountId}/callsigns/{callsignId}/verify   |                                            | Verify callsign evidence using the callsign.verify scope                           |
| GET    | /v1/identity/accounts/{accountId}/roles                           |                                            |                                                                                    |
| GET    | /v1/identity/accounts/{accountId}/export                          | exportAccount                              | Export an account's personal data                                                  |
| GET    | /v1/programmes                                                    |                                            | List configured programmes                                                         |
| POST   | /v1/programmes                                                    |                                            | Create a programme configuration                                                   |
| GET    | /v1/programmes/{slug}/policy                                      |                                            | Get the effective programme policy version                                         |
| GET    | /v1/entity-types                                                  |                                            | List shared entity category master data                                            |
| POST   | /v1/entity-types                                                  |                                            | Create or update a shared entity category definition                               |
| GET    | /v1/programmes/{slug}/entity-types                                |                                            | List entity categories assigned to the programme                                   |
| POST   | /v1/programmes/{slug}/entity-types                                |                                            | Legacy category upsert and assignment compatibility endpoint                       |
| GET    | /v1/geodata/entities                                              |                                            | List verified and candidate entities                                               |
| GET    | /v1/geodata/imports                                               |                                            | List geodata import runs                                                           |
| POST   | /v1/geodata/imports                                               |                                            | Create a geodata import resource and queue candidate preprocessing                 |
| GET    | /v1/geodata/imports/{runId}                                       |                                            | Get geodata import status and summary                                              |
| PUT    | /v1/geodata/imports/{runId}/cancellation                          |                                            | Cancel a queued upload or request cancellation of active preprocessing             |
| GET    | /v1/geodata/imports/{runId}/candidates                            |                                            | List the paged pre-processed records for an import run                             |
| POST   | /v1/geodata/imports/{runId}/candidates/validate                   |                                            | Confirm or reject selected pre-processed records for promotion                     |
| POST   | /v1/geodata/imports/{runId}/process                               |                                            | Queue selected records for entity promotion                                        |
| GET    | /v1/geodata/imports/{runId}/processing-queues/{queueId}           |                                            | Read the outcome of an import promotion queue                                      |
| POST   | /v1/geodata/imports/{runId}/processing-queues/{queueId}/redrive   |                                            | Redrive a failed import promotion queue                                            |
| POST   | /v1/geodata/imports/{runId}/processed                             |                                            | Finalize an import and discard staged records                                      |
| DELETE | /v1/geodata/load-test-runs/{testRunId}                            | deleteGeodataLoadTestRun                   | Clean up a tagged geodata load-test run                                            |
| POST   | /v1/geodata/import-uploads                                        |                                            | Create a restart-safe resumable geodata upload                                     |
| GET    | /v1/geodata/import-uploads/{uploadId}                             |                                            | Inspect an owned upload session and its received parts                             |
| DELETE | /v1/geodata/import-uploads/{uploadId}                             |                                            | Abort an owned incomplete upload session                                           |
| POST   | /v1/geodata/import-uploads/{uploadId}/parts/{partNumber}          |                                            | Upload or retry one bounded binary part                                            |
| POST   | /v1/geodata/import-uploads/{uploadId}/complete                    |                                            | Verify and complete an upload, then durably enqueue preprocessing                  |
| GET    | /v1/geodata/location-options                                      |                                            | List provider-derived location hierarchy options                                   |
| GET    | /v1/activations/entity-deletion-impacts/{entityId}                | getEntityDeletionImpact                    | Read the activity impact of deleting an entity                                     |
| POST   | /v1/activations/entity-deletion-cascades                          | cascadeEntityDeletion                      | Create the activity cascade for an approved geodata deletion job                   |
| GET    | /v1/activations                                                   |                                            | List activations for authorised operators and administrators                       |
| POST   | /v1/activations                                                   |                                            | Start an activation                                                                |
| GET    | /v1/activations/{activationId}                                    |                                            | Get an activation and its normalized QSOs                                          |
| PATCH  | /v1/activations/{activationId}                                    | patchActivation                            | Update an activation lifecycle state                                               |
| POST   | /v1/activations/{activationId}/qsos                               |                                            | Record a normalized QSO for an open activation                                     |
| GET    | /v1/awards                                                        |                                            | List programme-owned award definitions                                             |
| POST   | /v1/awards                                                        |                                            | Save a draft programme-owned award definition                                      |
| GET    | /v1/awards/{awardId}                                              |                                            | Get an award definition                                                            |
| PATCH  | /v1/awards/{awardId}                                              | patchAward                                 | Update an award or advance its draft lifecycle                                     |
| POST   | /v1/awards/{awardId}/submit                                       |                                            | Submit an award definition for review                                              |
| POST   | /v1/awards/{awardId}/review                                       |                                            | Approve or return an award definition for changes                                  |
| POST   | /v1/awards/{awardId}/publish                                      |                                            | Publish an approved award with an effective date                                   |
| GET    | /v1/awards/assets                                                 |                                            | List registered background and signature assets                                    |
| POST   | /v1/awards/assets                                                 |                                            | Register an image asset stored in S3-compatible object storage                     |
| GET    | /v1/awards/assets/{assetId}/content                               | getAwardAssetContent                       | Read bounded registered PNG/JPEG content for authenticated design                  |
| PUT    | /v1/awards/assets/{assetId}/content                               | putAwardAssetContent                       | Store and validate registered PNG/JPEG artwork through the API                     |
| POST   | /v1/awards/previews                                               | createAwardPreview                         | Render an unsaved certificate design with mock data without issuance or storage    |
| POST   | /v1/awards/evaluation-jobs                                        | createAwardEvaluationJob                   | Queue award condition evaluation                                                   |
| GET    | /v1/awards/evaluation-jobs/{jobId}                                | getAwardEvaluationJob                      | Get award evaluation job status                                                    |
| GET    | /v1/awards/progress                                               | getAwardProgress                           | Get award progress for a participant                                               |
| GET    | /v1/awards/requests                                               |                                            | List award requests                                                                |
| POST   | /v1/awards/requests                                               |                                            | Request an eligible award level                                                    |
| POST   | /v1/awards/requests/{requestId}/issuances                         | createAwardIssuance                        | Create a permanent award issuance                                                  |
| GET    | /v1/awards/issuances                                              |                                            | List permanent award issuance records                                              |
| POST   | /v1/awards/issuances/{issuanceId}/render-jobs                     | createCertificateRenderJob                 | Queue certificate rendering                                                        |
| GET    | /v1/awards/issuances/{issuanceId}/render-jobs/{jobId}             | getCertificateRenderJob                    | Get certificate render job status                                                  |
| GET    | /v1/awards/issuances/{issuanceId}/artifact                        | getAwardArtifact                           | Get the issued certificate artifact                                                |
| POST   | /v1/identity/auth/service-token                                   | issueServiceToken                          | Issue a short-lived service token for an authorised integration                    |
| GET    | /v1/identity/internal/email-recipients/{accountId}                | getEmailRecipientAddress                   | Resolve a deliverable email address for the email service                          |
| GET    | /v1/identity/accounts/{accountId}                                 |                                            | Get an account by identifier                                                       |
| PATCH  | /v1/identity/accounts/{accountId}                                 | patchIdentityAccount                       | Partially update an account and optionally replace its active administrative roles |
| PATCH  | /v1/identity/roles/{roleCode}                                     | patchIdentityRole                          | Partially update a custom administrative role                                      |
| PUT    | /v1/identity/accounts/{accountId}/role-assignments                | replaceAccountRoleAssignments              | Replace an account's active administrative role assignments                        |
| PUT    | /v1/identity/accounts/{accountId}/primary-callsign                | setPrimaryCallsign                         | Replace an account's primary callsign                                              |
| POST   | /v1/identity/accounts/{accountId}/callsigns/{callsignId}/retire   |                                            | Retire a callsign association                                                      |
| POST   | /v1/identity/oidc/providers                                       | saveOidcMapping                            | Register a programme-scoped OIDC provider mapping                                  |
| GET    | /v1/programmes/{slug}                                             |                                            | Get a programme configuration                                                      |
| PATCH  | /v1/programmes/{slug}                                             | patchProgramme                             | Partially update a programme configuration or archive it                           |
| PUT    | /v1/programmes/{slug}/entity-types/{categoryCode}                 | assignProgrammeEntityCategory              | Idempotently assign an entity category to a programme                              |
| DELETE | /v1/programmes/{slug}/entity-types/{categoryCode}                 | unassignProgrammeEntityCategory            | Idempotently remove an entity category from a programme                            |
| GET    | /v1/programmes/{slug}/content                                     |                                            | List programme-owned content versions                                              |
| POST   | /v1/programmes/{slug}/content                                     |                                            | Create or update a draft content version                                           |
| GET    | /v1/programmes/{slug}/content/coverage                            |                                            | Report programme content locale coverage                                           |
| POST   | /v1/programmes/{slug}/content/{contentId}/submit                  |                                            | Submit content for review                                                          |
| POST   | /v1/programmes/{slug}/content/{contentId}/review                  |                                            | Review programme content                                                           |
| POST   | /v1/programmes/{slug}/content/{contentId}/publish                 |                                            | Publish programme content                                                          |
| PATCH  | /v1/programmes/{slug}/content/{contentId}                         | patchProgrammeContent                      | Update content or advance its draft lifecycle                                      |
| GET    | /v1/programmes/{slug}/policy-drafts                               |                                            | List programme policy drafts                                                       |
| POST   | /v1/programmes/{slug}/policy-drafts                               |                                            | Create or update a programme policy draft                                          |
| POST   | /v1/programmes/{slug}/policy-drafts/{draftId}/submit              |                                            | Submit a policy draft for review                                                   |
| POST   | /v1/programmes/{slug}/policy-drafts/{draftId}/review              |                                            | Review a policy draft                                                              |
| POST   | /v1/programmes/{slug}/policy-drafts/{draftId}/publish             |                                            | Publish a policy draft                                                             |
| PATCH  | /v1/programmes/{slug}/policy-drafts/{draftId}                     | patchProgrammePolicyDraft                  | Update a policy draft or advance its lifecycle                                     |
| GET    | /v1/geodata/adapters                                              |                                            | List supported geodata import adapters and formats                                 |
| GET    | /v1/geodata/entities/{entityId}                                   |                                            | Get a geodata entity                                                               |
| PATCH  | /v1/geodata/entities/{entityId}                                   | patchGeodataEntityMetadata                 | Update editable entity metadata                                                    |
| GET    | /v1/geodata/entities/{entityId}/audit                             |                                            | Get entity review, geometry, and lifecycle audit context                           |
| POST   | /v1/geodata/entities/{entityId}/location-enrichment-requests      | postGeodataEntityLocationEnrichmentRequest | Queue reverse-geocoding for missing entity location metadata                       |
| GET    | /v1/geodata/tiles/{z}/{x}/{y}                                     |                                            | Get a vector tile for geodata display                                              |
| GET    | /v1/geodata/refresh-schedules                                     |                                            | List geodata refresh schedules                                                     |
| POST   | /v1/geodata/refresh-schedules                                     |                                            | Create a geodata refresh schedule                                                  |
| POST   | /v1/geodata/refresh-schedules/{scheduleId}/run                    |                                            | Run a geodata refresh schedule                                                     |
| POST   | /v1/geodata/proposals                                             | postGeodataProposal                        | Submit a community proposal for candidate promotion                                |
| GET    | /v1/geodata/conflation                                            |                                            | List open geodata conflation candidates                                            |
| POST   | /v1/geodata/conflation/{candidateId}/resolve                      |                                            | Resolve a geodata conflation candidate                                             |
| PUT    | /v1/geodata/entities/{entityId}/geometry                          | putGeodataEntityGeometry                   | Replace an entity geometry with validated GeoJSON                                  |
| PUT    | /v1/geodata/entities/{entityId}/categories                        | putGeodataEntityCategories                 | Replace an entity's shared category assignments                                    |
| POST   | /v1/geodata/entities/{entityId}/reviews                           | postGeodataEntityReview                    | Record an entity lifecycle review decision                                         |
| POST   | /v1/geodata/entity-deletion-jobs                                  | createGeodataEntityDeletionJob             | Create an entity deletion impact and confirmation job                              |
| GET    | /v1/geodata/entity-deletion-jobs/{jobId}                          | getGeodataEntityDeletionJob                | Get an entity deletion job                                                         |
| POST   | /v1/geodata/entity-deletion-jobs/{jobId}/confirm                  | confirmGeodataEntityDeletionJob            | Confirm and queue entity deletion                                                  |
| POST   | /v1/qso-ingestions                                                | createQsoIngestion                         | Queue a high-volume normalized QSO ingestion                                       |
| POST   | /v1/qso-ingestions/csv                                            | createCsvQsoIngestion                      | Upload and queue a CSV QSO log for an activation                                   |
| GET    | /v1/qso-ingestions/{ingestionId}                                  | getQsoIngestion                            | Get QSO ingestion job status                                                       |
| POST   | /v1/adif/imports                                                  | createAdifImport                           | Upload and queue an ADIF log for an activation                                     |
| GET    | /v1/adif/imports/{importId}                                       |                                            | Get ADIF import status                                                             |
| POST   | /v1/activity/work-jobs/{jobId}/redrive                            |                                            | Redrive a failed or recoverable Activity work job                                  |
| POST   | /v1/qsos/{qsoId}/corrections                                      |                                            | Request a QSO correction                                                           |
| POST   | /v1/qsos/{qsoId}/corrections/{correctionId}/review                | reviewQsoCorrection                        | Review a QSO correction under its QSO resource                                     |
| GET    | /v1/public/activations                                            |                                            | List public activation history                                                     |
| GET    | /v1/public/leaderboards                                           |                                            | List public programme leaderboards                                                 |
| GET    | /v1/public/results                                                |                                            | Download public activation results                                                 |
| POST   | /v1/statistics/rebuild-jobs                                       | createStatisticsRebuildJob                 | Create a reproducible activity statistics rebuild job                              |
| GET    | /v1/statistics/rebuild-jobs/{jobId}                               | getStatisticsRebuildJob                    | Get statistics rebuild job status                                                  |
| GET    | /v1/statistics                                                    |                                            | List precomputed activity statistics                                               |
| GET    | /v1/notifications                                                 |                                            | List notifications for the authenticated account                                   |
| POST   | /v1/awards/{awardId}/recalculation-jobs                           | createAwardRecalculationJob                | Queue historical award progress recalculation                                      |
| GET    | /v1/awards/{awardId}/recalculation-jobs/{jobId}                   | getAwardRecalculationJob                   | Get award recalculation job status                                                 |
| POST   | /v1/awards/{awardId}/retire                                       |                                            | Retire an award definition                                                         |
