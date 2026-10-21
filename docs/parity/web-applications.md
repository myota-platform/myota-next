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
review, and editing scoped to the selected programme. The Admin Awards screen uses
independent bounded paging for award
definitions, requests, and issuances; the asset catalogue follows its API pages
for design selection. The Participant client includes localized published programme content,
paged approved/candidate entity catalogue and map, map-picked point proposals and existing-candidate proposals, published award and level catalogue with eligible-level requests using the current Identity account and callsign data, rotating Identity refresh-session recovery for authenticated requests, activation creation and complete paged own-activation history for QSO selection,
single-QSO entry, profile editing and image management, and owner callsign
creation, evidence submission, primary selection, and retirement. Chromium browser checks
exercise Admin sign-in, identity session bootstrap, scope denial, Participant
programme selection and public content, and its activation, QSO, and close
workflow. Activation creation and QSO recording retain their request body and
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
version-checked candidate review, and conflict recovery for entity metadata
edits by reloading the latest server version. Activity browser checks cover
activation/QSO detail viewing and statistics rebuild submission with an
idempotency key and job status refresh. The Admin Activity screen also lists,
filters, pages, and reviews QSO correction requests. Review cards identify both
requester and operator, and confirmations explain the effect of applying versus
rejecting. This target extension lacks browser-level compatibility coverage.
Award browser checks cover programme-
scoped draft creation, its idempotency key and condition/level payload, and
the submit, approve, and publish lifecycle. Master data browser checks cover shared
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
Geodata deletion job creation and confirmation also retain their keys across
same-tab retries and reloads. Entity reviews, metadata/category/geometry/location
updates, enrichment requests, manual proposals, and import finalization use the
same persistence. Refresh schedule creation and runs plus conflation decisions
also retain their keys across same-tab retries and reloads.
The Identity account editor exposes callsign creation with status, source, and
validity fields; evidence submission with checksum and metadata; verification
for callers with `callsign.verify` and a configurable verification source;
primary selection; and retirement with an optional effective date. Owner and
global-scope checks follow the API authorization rules. The Participant
profile exposes the owner-authorized callsign actions. These
callsign controls do not yet have browser-level compatibility coverage. Admin
account creation and both clients' callsign creation and primary-selection
retries reuse their idempotency key for the same request across page reloads in
the same tab. The Participant client reports profile-refresh failure separately
from a successful mutation; Admin keeps the key until both the mutation and
profile refresh succeed.
The Admin import form also supports resumable KML and GPX file uploads up to
1 GiB, alongside GeoJSON, OSM PBF, and Shapefile ZIP uploads. The API can
enforce lower format-specific limits. The award catalogue follows all API
pages. Remaining work includes accessibility/visual review and deployment
integration. Its public map renders point, line, polygon, and multipart entity
geometries.
