# Web applications

| Application     | Required parity                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin web       | Login and role-aware navigation; account and role management; programme/category/content/policy administration; Geodata catalogue, import, preprocessing, review, entity editing, maps and deletion; Activity/QSO and award administration; observability access. Preserve accessible keyboard workflows, confirmation of destructive actions, conflict handling, bounded paging, resumable upload behavior, and accurate loading/error states. |
| Participant web | Programme selection, public programme content and rules, approved/candidate entity table and map, candidate proposal, authenticated profile editing, callsign self-service, and cropped profile-image upload, published award/level display and request, activation creation and own activation history, QSO entry, and activation close. Keep programme policy, callsign authorization, and eligibility decisions on owning services.          |

The baseline Admin and Participant applications are carried forward under
`web/` with separate deployment artifacts. The Admin build is checked in CI;
a static source scan resolves 62 concrete Admin HTTP method/path pairs, all
present in the OpenAPI contract. This does not establish payload or workflow
parity. The Admin programme editor and Participant selector follow the
programme API's page metadata so both receive the complete catalogue. The Admin
Content and Policy views page versions independently while keeping coverage,
review, and editing scoped to the selected programme. Programme creation and
Content draft browser coverage retry uncertain saves after reload and verify
reuse of the exact request body and key; the Content flow also completes review
and publication. The Admin Awards screen uses
independent bounded paging for award
definitions, requests, and issuances; the asset catalogue follows its API pages
for design selection. The Participant client includes localized published programme content,
paged approved/candidate entity catalogue and map, map-picked point proposals and existing-candidate proposals, published award and level catalogue with eligible-level requests using the current Identity account and callsign data, rotating Identity refresh-session recovery for authenticated requests, activation creation and complete paged own-activation history for QSO selection,
single-QSO entry, profile editing and image management, and owner callsign
creation, evidence submission, primary selection, and retirement. Chromium browser checks
exercise Admin sign-in, identity session bootstrap, scope denial, Participant
programme selection and public content, and its activation, QSO, and close
workflow. In CI, live browser checks sign into Admin and load its dashboard,
create a participant account with an authorized Activity role through Gateway,
add and verify its callsign, activate the account, export its data, and
deactivate and anonymize it through Gateway. A separate workflow creates a
programme through Gateway before Participant loads its catalogue,
published-content response, and empty Geodata entity page through the Vite
proxy and running NestJS services. Other browser workflows continue to use
intercepted API responses.
Activation creation and QSO recording retain their
request body and
idempotency key for retries with unchanged inputs, including a page reload in
the same tab. Activation close confirms an uncertain response by refreshing the
operator's activation history, since the close API rejects requests for an
activation that is no longer open. Browser checks also cover profile details editing,
image crop/upload, an eligible award
request, safe biography Markdown preview, and existing-candidate and map-picked
point proposals with intercepted API responses. Proposal submissions retain
their exact request body and idempotency key for same-tab retries across reloads.
Admin browser checks also cover
sign-in, session bootstrap,
scope denial, Identity account creation with a permitted role grant and custom
role creation from the permission catalogue, account search and edits that
preserve unchanged scoped assignments, account export and confirmed
deactivation/anonymization, programme creation with policy/category settings,
policy draft save, review, and publication, and
version-checked candidate review, and entity metadata conflict recovery
followed by a successful edit against the reloaded server version. Geodata
management browser coverage also saves manual location overrides with provider
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
Award browser checks cover programme-
scoped draft creation, its idempotency key and condition/level payload, and
the submit, approve, and publish lifecycle. Award creation, definition edits,
and lifecycle state changes retain idempotency keys for same-tab retries across
reloads; a live CI browser workflow creates a programme and submits, approves,
and publishes a RULES policy in Admin through Gateway. Intercepted award and
policy draft browser checks also retry an uncertain save after reload and
verify reuse of the exact request body and key.
Master data browser checks cover shared
category creation, geometry type selection, inactive lifecycle, and the
idempotency key. Programme category assignment and removal retain their
idempotency keys across same-tab retries and reloads. Shared category saves
and programme creation also retain their keys across same-tab retries and
reloads. Programme edits and archive, content draft saves and lifecycle
actions, and policy draft saves and lifecycle actions retain their keys for
same-tab retries across reloads. Conflation review browser checks cover a keep-separate
decision, survivor selection, reviewer attribution, and note. Other Admin
workflows still lack browser-level compatibility coverage. Refresh schedule
checks cover programme-scoped schedule creation and queuing a complete manual
GeoJSON snapshot. Import checks cover pasted GeoJSON queueing, source metadata,
candidate listing and review, plus idempotent durable candidate promotion.
Single-item decisions and bulk candidate promotion or rejection retain their
idempotency keys across same-tab retries and reloads. Pasted imports retain
their exact request body and idempotency key for same-tab retries after reload.
Geodata deletion browser coverage now verifies impact preparation, explicit
confirmation, cascade completion, removal from the entity list, and reuse of
the same preparation and confirmation keys after uncertain responses and page
reloads. Deletion job creation and confirmation retain their keys across
same-tab retries and reloads. Entity reviews, metadata/category/geometry/location
updates, enrichment requests, manual proposals, and import finalization use the
same persistence. Refresh schedule creation and runs plus conflation decisions
also retain their keys across same-tab retries and reloads.
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
The Admin import form also supports resumable KML and GPX file uploads up to
1 GiB, alongside GeoJSON, OSM PBF, and Shapefile ZIP uploads. The API can
enforce lower format-specific limits. The award catalogue follows all API
pages. Remaining work includes accessibility/visual review and deployment
integration. Its public map renders point, line, polygon, and multipart entity
geometries.
