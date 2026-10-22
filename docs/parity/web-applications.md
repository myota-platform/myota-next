# Web applications

| Application     | Required parity                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin web       | Login and role-aware navigation; account and role management; programme/category/content/policy administration; Geodata catalogue, import, preprocessing, review, entity editing, maps and deletion; Activity/QSO and award administration; observability access. Preserve accessible keyboard workflows, confirmation of destructive actions, conflict handling, bounded paging, resumable upload behavior, and accurate loading/error states.                                                    |
| Participant web | Programme selection, public programme content and rules, approved/candidate entity table and map, candidate proposal, authenticated profile editing, callsign self-service, and cropped profile-image upload, published award/level display, eligible request, owner-scoped status, and issued certificate download, activation creation and own activation history, QSO entry, and activation close. Keep programme policy, callsign authorization, and eligibility decisions on owning services. |

The baseline Admin and Participant applications are carried forward under
`web/` with separate deployment artifacts. The Admin build is checked in CI;
a static source scan resolves 62 concrete Admin HTTP method/path pairs, all
present in the OpenAPI contract. This does not establish payload or workflow
parity. Dashboard browser coverage verifies scope-limited data requests,
role-specific metrics and panels, and that available workspaces remain usable
when a permitted data source fails. The dashboard reuses the programme
catalogue loaded during session bootstrap and refreshes it only when requested.
The Admin programme editor and Participant selector follow the programme API's
page metadata so both receive the complete catalogue. The Admin
Content and Policy views page versions independently while keeping coverage,
review, and editing scoped to the selected programme. Programme creation and
Content draft browser coverage retry uncertain saves after reload and verify
reuse of the exact request body and key; the Content flow also completes review
and publication. A live Admin workflow creates a Content draft, submits it for
review, approves and publishes it, then verifies the Core record, outbox
lifecycle, and public programme-content response. The Admin Awards screen uses
independent bounded paging for award
definitions, requests, and issuances; the asset catalogue follows its API pages
for design selection. The Participant client includes localized published programme content,
paged approved/candidate entity catalogue and map, map-picked point proposals and existing-candidate proposals, published award and level catalogue with eligible-level requests and owner-scoped request status using the current Identity account and callsign data, rotating Identity refresh-session recovery for authenticated requests, activation creation and complete paged own-activation history for QSO selection,
single-QSO entry, profile editing and image management, and owner callsign
creation, evidence submission, primary selection, and retirement. Chromium browser checks
exercise Admin sign-in, identity session bootstrap, scope denial, Participant
programme selection and public content, and its activation, QSO, and close
workflow. In CI, live browser checks sign into Admin and load its dashboard,
create a participant account with an authorized Activity role through Gateway,
add and verify its callsign, activate the account, export its data, and
deactivate and anonymize it through Gateway. A live Admin UI workflow also
exports an account and confirms deactivation/anonymization, then checks the
stored account/profile values and lifecycle event. Another workflow signs in as
a participant and exercises owner callsign creation, evidence submission,
primary selection, and retirement plus profile detail editing against the live
Identity API. A separate workflow creates a
programme through Gateway before Participant loads its catalogue,
published-content response, and empty Geodata entity page through the Vite
proxy and running NestJS services. Other browser workflows continue to use
intercepted API responses. Participant activation creation, QSO recording, and
activation closing now run through live Activity APIs; the entity catalogue is
seeded by the browser fixture for this workflow. Participants can upload ADIF
logs to open activations and follow queued, processing, completed, and failed
status with accepted and rejected record totals. A live browser workflow
uploads through the Participant app and Gateway, then checks the processed QSO
and completion notification.
Activation creation and QSO recording retain their
request body and
idempotency key for retries with unchanged inputs, including a page reload in
the same tab. Activation close confirms an uncertain response by refreshing the
operator's activation history, since the close API rejects requests for an
activation that is no longer open. Browser checks also cover profile details editing,
image crop/upload, an eligible award
request, safe biography Markdown preview, and existing-candidate and map-picked
point proposals with intercepted API responses. A live browser workflow now
submits both proposal forms through Participant, Gateway, and Geodata, then
waits for Geodata worker processing and checks the import metadata, proposal
identity, and resulting CANDIDATE entities in the Geodata database. The
reference turns Participant proposals directly into CANDIDATE entities, so
they do not require a separate Admin review step. Participant sees the resulting
candidates in its catalogue. Proposal submissions retain their exact request
body and idempotency key for same-tab retries across reloads.
Admin browser checks also cover
sign-in, session bootstrap,
scope denial, Identity account creation with a permitted role grant and custom
role creation from the permission catalogue, account search and edits that
preserve unchanged scoped assignments, account export and confirmed
deactivation/anonymization, programme creation with policy/category settings,
policy draft save, review, and publication, version-checked candidate
review, and entity metadata conflict recovery
followed by a successful edit against the reloaded server version. A live Admin
workflow also creates and edits a custom Identity role through Gateway, reloads
the role to confirm its permissions persisted, and verifies both role lifecycle
events in the Core security and outbox records. Another live Identity Admin
workflow starts with a scoped Geodata grant, confirms duplicate-email conflict
handling, updates account fields without resubmitting role grants, and checks the
scoped assignment remains persisted. It then resets the account password in
the Admin UI, verifies the previous password and refresh session are rejected,
and signs in with the new password. Changing the account status to deactivated
then verifies that the new owner refresh session remains rotatable. Geodata
management browser coverage also
saves manual location overrides with provider
codes and queues enrichment against the updated entity version. Activity
browser checks cover
activation/QSO detail viewing and statistics rebuild submission with an
idempotency key and job status refresh. The Admin Activity screen also lists,
filters, pages, and reviews QSO correction requests. Review cards identify both
requester and operator, and confirmations explain the effect of applying versus
rejecting. Intercepted browser coverage verifies the affected QSO context,
status filtering, review notes, paging, and both apply and reject outcomes. A
live CI browser workflow creates an isolated programme, activation, QSO, and
correction, applies the correction in Admin, and verifies the updated QSO
through Gateway.

A live Admin browser workflow creates two shared categories, creates a
programme with one category, then assigns and removes the other through the
programme editor and Gateway. It verifies the resulting Core catalogue and
programme records, idempotency keys, and catalogue, assignment, and removal
outbox events. It then edits the programme and archives it through the live
editor, confirming the final Core record and both lifecycle outbox events.

Another live Admin and Participant workflow creates a printable background
asset, saves an activator award draft, submits and approves it, and publishes
it through Gateway. It then creates and verifies a participant callsign,
records a live activation, signs in through Participant, and requests the
eligible award level. Admin then issues the request with a registered signature
asset, and Participant sees the resulting issued status. The owner can read
their own requests through Activity; attempts to read another participant's
requests are denied. Admin can queue the PDF render; Participant sees that
preparation is pending and receives a download action after the worker stores
the artifact. The browser API stack uses an ephemeral S3-compatible store for
the artwork upload and read-back; CI verifies the stored Activity assets,
published award definition, request facts, issuance record, render job,
print-readiness result, and award lifecycle outbox events. The Admin issuance
list retains the latest render-job status when the view reloads.

An additional live browser workflow seeds an isolated Geodata entity and a
catalogue-backed country value, signs in as the bootstrap administrator, edits
the entity's country and city through Admin and Gateway, then verifies the
persisted manual-field markers, revision, and audit event in the Geodata
database. This complements the intercepted location-form checks with evidence
across the live browser, API, authorization, transaction, and database
boundaries.

The live Participant Identity workflow also uploads a cropped profile picture,
checks its stored WebP metadata and bytes through Gateway, removes it, and
confirms the image is no longer available. The same workflow verifies profile
details and owner callsign management.

The Participant certificate control also has an intercepted browser check:
issued requests show processing without a download action until the API marks
the PDF ready, after which the signed download URL opens with the participant's
authorization used for the artifact lookup.
Award browser checks cover programme-
scoped draft creation, its idempotency key and condition/level payload, the
live eligible participant request and Admin issuance flows, and the submit,
approve, and publish lifecycle. Award creation, definition edits,
and lifecycle state changes retain idempotency keys for same-tab retries across
reloads; a live CI browser workflow creates a programme and submits, approves,
and publishes a RULES policy in Admin through Gateway. Intercepted award and
policy draft browser checks also retry an uncertain save after reload and
verify reuse of the exact request body and key.
The Admin Activity page's statistics maintenance workflow also runs live
through Gateway and the Activity worker: CI verifies the queued job reaches
`SUCCEEDED`, the status appears in the page, and the completed job is persisted
in Activity. The worker's entity and jurisdiction snapshots are checked against
the seeded activation totals.
Master data browser checks cover shared
category creation, geometry type selection, inactive lifecycle, and the
idempotency key. Programme category assignment and removal retain their
idempotency keys across same-tab retries and reloads. Shared category saves
and programme creation also retain their keys across same-tab retries and
reloads. Programme edits and archive, content draft saves and lifecycle
actions, and policy draft saves and lifecycle actions retain their keys for
same-tab retries across reloads. Intercepted Conflation review checks cover a
keep-separate decision, survivor selection, reviewer attribution, and note. A
live Admin workflow also records that decision through Gateway and verifies
the persisted survivor, reviewer, history, idempotency record, and outbox event.
Other Admin
workflows still lack browser-level compatibility coverage. Refresh schedule
checks create a temporary category and an all-programmes schedule in Admin,
then upload an empty complete GeoJSON snapshot and verify worker completion
through live services. A separate Gateway check verifies the schedule record,
manifest, processing queue, timestamps, and outbox events. Import checks cover
pasted GeoJSON queueing, source metadata,
candidate listing, rejection through the validation endpoint, and promotion of
the next candidate through its durable queue. The browser check verifies the
reviewer, candidate IDs, and idempotency keys for both decisions.
Single-item decisions and bulk candidate promotion or rejection retain their
idempotency keys across same-tab retries and reloads. Pasted imports retain
their exact request body and idempotency key for same-tab retries after reload.
The Map explorer browser check pages through the 100-entity catalogue and
verifies map selection shows the selected entity's status, categories,
programme memberships, and location. Geodata deletion browser coverage now
verifies impact preparation, explicit confirmation, cascade completion,
removal from the entity list, and reuse of
the same preparation and confirmation keys after uncertain responses and page
reloads. Deletion job creation and confirmation retain their keys across
same-tab retries and reloads. Entity reviews, metadata/category/geometry/location
updates, enrichment requests, manual proposals, and import finalization use the
same persistence. Refresh schedule creation and runs plus conflation decisions
also retain their keys across same-tab retries and reloads.
An additional live Admin workflow replaces an approved entity's geometry
through Gateway and Geodata, checking its version and idempotency headers, saved
geometry history, audit event, and outbox event.
The live browser suite also runs a confirmed entity deletion through the
Geodata API, Geodata worker, Activity cascade API, and both owner databases. It
checks the displayed impact, completion state, removal of linked QSOs and
corrections, activation invalidation, and queued award recalculation. CI
provisions its bounded JetStream topology before starting the workers.
Candidate status review also runs live through Admin, Gateway, and Geodata; the
browser check verifies the version and idempotency headers, reviewer and note,
status history, audit event, and outbox event persisted by Geodata.
Another live Admin workflow pastes a GeoJSON dataset, waits for worker
preprocessing, rejects one record, promotes another to a candidate, and checks
the persisted import, review, promotion queue, and entity states. The worker
reads the pasted source from the CI S3-compatible fixture. A second live Admin
workflow uploads a GeoJSON file through the resumable multipart UI, completes
the S3-compatible object upload, and waits for Geodata preprocessing. It checks
the completed upload session and import, stored part size and source hash, and
the resulting review candidates for GeoJSON, OSM GeoJSON, WFS GeoJSON, ArcGIS FeatureServer JSON, KML, GPX, OSM PBF, Shapefile, and ParkServe US ZIP.
The Identity account editor exposes callsign creation with status, source, and
validity fields; evidence submission with checksum and metadata; verification
for callers with `callsign.verify` and a configurable verification source;
primary selection; and retirement with an optional effective date. Owner and
global-scope checks follow the API authorization rules. The Participant
profile exposes the owner-authorized callsign actions. Browser checks now
exercise Admin callsign creation, evidence submission, verification, primary
selection, and retirement with replacement, plus the Participant owner flow
for creation, evidence, primary selection, and primary retirement. Admin
account creation and both clients' callsign creation and primary-selection
retries reuse their idempotency key for the same request across page reloads in
the same tab. Participant browser coverage verifies that a successful callsign
save remains distinct from a failed profile refresh. Admin keeps the key until
both the mutation and profile refresh succeed. Programme browser coverage also
verifies that
uncertain edit and archive responses can be retried after reload with the same
request body and idempotency key, after confirming the archive action. The
programme editor reports archive failures and confirms success after the
programme catalogue refreshes.
The Admin import form supports resumable GeoJSON, OSM GeoJSON, WFS GeoJSON,
ArcGIS FeatureServer JSON, KML, GPX, OSM PBF, Shapefile ZIP, and ParkServe US
ZIP uploads, subject to the configured source limits. The award catalogue follows all API
pages. Remaining work includes accessibility/visual review and deployment
integration. Its public map renders point, line, polygon, and multipart entity
geometries.
