# Administration workflows

The administration web is intentionally programme-agnostic. It stores and publishes programme-owned data; it does not copy rules, charters, eligibility, award definitions, or content from POTA, MPOTA, or another programme.

## Geodata review

Open **Geodata review** and choose a programme. The map separates `CANDIDATE`, `APPROVED`, `RETIRED`, and `REJECTED` entities into distinct visual layers. Select an entity on the map or in the list to open its inspector; the map automatically centers and zooms to the selected geometry.

The review queue is bound to the visible map bounding box. Panning or zooming
refreshes the queue through the geodata API with the current `minLon`,
`minLat`, `maxLon`, and `maxLat` values, so entities outside the selected map
area are not displayed.

Each paged result has a selection checkbox. **Select all on this page** selects
only the currently displayed page. The page-size selector offers 25, 50, or 100
entities, and changing filters or the page size clears the selection. The bulk
approval action sends an audited `APPROVED` status transition for each eligible entity; already approved entities are skipped and
retired entities remain protected by the lifecycle rule. Global administrators
also have **Delete entities permanently**. Before deletion, the UI gathers the
impact for every selected entity and shows the same stern warning used by the
single-entity action, including the number of valid QSOs and activations that
will be affected. For bulk deletion, the modal appears immediately and then
loads impact and confirmation-job details in small batches. A failed lookup is
shown on the affected entity with a retry action instead of hiding the modal.
Creating these confirmation jobs does not publish deletion events; events are
queued only after the administrator presses the final confirmation button.
Deletion cascades through activity data, queues award
recalculation, removes the geodata record and audit record, and cannot be
undone. Single and bulk deletion both poll their durable job until completion
or failure. Bulk status polling continues through transient read errors until all
jobs reach a terminal state, then closes the dialog and reports any failures.
The dialog remains closable while that background work continues; closing it
does not cancel a confirmed delete. Each request has a bounded client timeout,
and a timed-out status read is retried rather than ending the polling cycle.

The **Entity status** editor allows an approver to set the lifecycle status directly from the inspector. Status changes are recorded in the audit history and emit a status-change event. An `APPROVED` entity can only move to `RETIRED`; a retired entity cannot be reactivated. This protects historical QSOs from being associated with a later-invalidated entity.

The inspector provides:

- the original imported source feature/provenance beside the current platform geometry;
- a read-only geometry view until the explicit **Edit geometry** action is selected;
- Leaflet-Geoman draggable point or polygon vertices for a review-time geometry correction;
- a required-by-practice geometry note, which is retained in geometry history;
- proposal and approval/rejection actions with a reviewer note;
- combined review and geometry audit history.

Geometry edits never overwrite the stored source snapshot. Approval is an explicit state transition and remains subject to the authenticated approver scope enforced by the geodata service.

## Geodata imports

Open **Geodata imports** for platform-wide dataset intake. Choose one or more
shared categories, then either paste a supported text document or upload a
file. A file satisfies the source requirement by itself; the paste field is
optional whenever a file has been selected. Binary formats must be uploaded.

For OpenStreetMap exports, select **OpenStreetMap GeoJSON**. The service uses
the OSM adapter, preserves ODbL attribution/source references, and applies the
configured OSM tag filter before records enter the validation queue.

Active pre-processed runs are shown in a dedicated **Pre-processing queue** on
the imports page. This queue is intentionally separate from Geodata Review:
records remain normalized candidates until an administrator confirms them and
queues their promotion. The import history below it contains completed and
failed runs.

Submitting a text dataset returns immediately with a `QUEUED` import run. Text
parsing, geometry normalization, and deduplication run asynchronously, so large
pasted FeatureCollections do not hold the browser request open. Reverse
geocoding occurs after an entity is materialized or its geometry changes, not
during import preprocessing. The run first reaches `PREPROCESSED`; records are shown in a
compact paged validation queue in the import summary modal. Confirm up to 300
selected records, then choose `CANDIDATE` or `APPROVED` to apply their final
state synchronously. Bulk import intake and preprocessing stay asynchronous.
Selections above 300 records are rejected before mutation; the run remains
visible after the page is refreshed.

Click a pre-processed record's name to open a Leaflet map preview centered on
that record. The modal offers **Promote to candidate**, **Promote to approved**,
and **Reject entity**. Each decision completes synchronously in the Geodata
API; promotion returns only after the entity and outbox transaction commits.
The service validates a selected set completely and commits all changes or
rejects the request without partial promotion. Failures remain on the current
item and can be retried with the same idempotency key. When no pending item
remains, the modal says the last item was processed and offers **Close review**.

When the review is complete, use **Mark import as processed**. After
confirmation, the service permanently removes the run's staged candidate and
promotion-queue rows, records who finalized it, changes the run to
`PROCESSED`, and keeps only the top-level import summary in the modal. Any
entities already created by the promotion worker are not removed by this
cleanup action.

Click any run in **Recent import runs** to open its summary. The modal shows
the lifecycle status, timestamps, selected categories, source licence and
attribution, source hash/change information, counts of pre-processed and
promoted records, disappeared records, and processing errors. Imports are
programme-independent. An Admin promotion or approval validates and commits
its selected set synchronously. Automatic community-proposal imports may use
the internal worker promotion queue.
The run list is ordered newest-first so newly submitted files remain visible
on the first page of the history and pre-processing queue.

Records with identical geometry or an existing entity within 50 metres show a
**Possible duplicate** warning. Select that warning to open a Leaflet comparison
map with the incoming and existing geometries in separate colours. The warning
does not block confirmation; the administrator decides whether the record is a
legitimate update, a separate entity, or should be rejected.

## Entity catalogue management

Open **Entity catalogue** and select an entity to open its management dialog.
The **Name & categories** tab presents Entity name, Entity categories, Website,
and Description in that order. Users with the geodata review permission can
edit these fields and use the single **Save details** action; blank Website or
Description values clear them. Name and public metadata use the existing
versioned metadata endpoint, while categories use the existing versioned
category endpoint. The UI refreshes the entity revision between requests and
reports partial completion if a later request fails. Other users can inspect
the values but cannot change them.

Website accepts an optional absolute HTTP or HTTPS URL up to 2,048 characters.
Description is optional plain text up to 2,000 characters. The separate review
inspector shows the saved Website as a safe external link and displays missing
legacy values as “Not provided”.

## Entity map

The **Entity map** page is a read-only Leaflet view of the complete stored
geodata catalogue. It loads the paged entity API, clusters point markers with
Leaflet.markercluster using chunked loading and spiderfy-at-maximum-zoom,
keeps line and polygon geometries visible as individually selectable overlays,
and fits the initial view to the available data. The review and management
maps use the same behavior; the point currently being edited stays outside
the cluster so its geometry editor remains directly addressable.
Selecting a shape or clustered marker opens a popup containing the entity name,
stored location metadata, all shared category codes/labels, and the programmes
that explicitly contain the entity or are assigned one of its categories. The
page does not enable geometry editing; use Geodata review for audited changes.

Global administrators and GIS administrators can change an entity between
point and polygon geometry. Point-to-polygon conversion creates a small
editable starting area; polygon-to-point conversion uses the geometry
centroid. Both the previous geometry and the reason are retained in audit
history. Rejected entities also expose a permanent delete action to global or
GIS administrators. Deletion removes the entity, related conflation records,
and its audit record, and cannot be undone.

Use **New candidate** to choose a polygon area, way/trail, or point location. Leaflet-Geoman closes polygons when the first vertex is selected again (and also offers its normal finish control). For point entities, click once on the map. Add the name, select one or more shared entity categories from the database-backed multi-select, jurisdiction, and optional evidence URI, then submit it as a `CANDIDATE`. The first category is retained as the compatibility primary category; the complete list is persisted by the geodata service. Programme assignment is optional and remains a separate eligibility decision. The API validates geometry, coordinate ranges, CRS, feature size, and attachment metadata before accepting it.

The category list is never hardcoded in the browser. It is loaded from the
shared Master data catalogue. The same multi-select is available when editing
an existing entity, and category filters match entities containing any
selected category.

Geodata ownership, workflows, and qualification records are indexed in the [canonical Geodata documentation](https://github.com/myota-platform/myota-docs/tree/main/docs/geodata).

## Content and translations

## Users and roles

Open **Identity** to edit account display name, email, status and optional
password reset. Users may hold multiple roles at once. The role catalogue
contains built-in least-privilege roles such as Identity administrator, GIS
administrator, Geodata approver, Programme administrator, Activity
administrator, and Auditor. Global administrators can create custom roles and
select from the controlled administrative permission catalogue; wildcard
access is reserved for the global administrator role.

Open **Content & translations** to manage programme-owned content keys by locale. A content version moves through:

`DRAFT` → `UNDER_REVIEW` → `APPROVED` → `PUBLISHED`

Reviewers can return a version as `CHANGES_REQUESTED`. Published versions are immutable; create a new draft to change them. Publishing requires an explicit effective date and publisher identity. Each locale can name a fallback locale, and the coverage panel reports published keys, missing keys, and percentage coverage for every programme locale.

## Rules and awards

Open **Programmes → Rules & policies** to create programme-owned `RULES` or `AWARD` drafts. The schema is deliberately JSON because each programme defines its own thresholds, eligibility, award requirements, labels, and supporting metadata. Certificate design remains a separate **Awards & certificates** workspace. Published versions are read-only; publication dates are explicitly UTC.

Policy versions move through the same draft/review/publish lifecycle. Publishing requires an explicit effective date and publisher identity. A published rules version becomes the programme’s effective rules snapshot; a published award is appended to the programme’s award catalogue with its version and effective date. Existing published versions are immutable.

## Local verification

The local Compose deployment serves this administration web on port `8090`. Use the bootstrap administrator configured in the local environment, then exercise each workflow against the sample programme data. The MPOTA records are synthetic sample data only and are not a source of platform rules.

## Sevilla sample map data

The local sample geodata contains three OSM-referenced parks around Sevilla: Parque de María Luisa, Parque del Alamillo, and Parque de los Príncipes. Two are seeded as approved references and Los Príncipes is seeded as a candidate so the review lifecycle is immediately visible. Each record keeps its OSM way reference, source URL, ODbL metadata, and source feature snapshot.

The map uses the standard HTTPS OpenStreetMap tile endpoint only for the tiles currently visible in the interactive viewport. It supports drag panning, mouse-wheel zoom, and explicit zoom controls, and displays `© OpenStreetMap contributors` plus a “Report a map issue” link. The page and nginx response use `strict-origin-when-cross-origin`, so the browser sends a valid origin `Referer`; browser JavaScript cannot set a `User-Agent`, so the browser supplies its normal identifiable one. Requests are not prefetched or made available offline, and normal browser caching is preserved. Production deployments should review traffic volume and the [OpenStreetMap tile usage policy](https://operations.osmfoundation.org/policies/tiles/) before using the public tile service at scale; a managed or self-hosted tile provider is the planned production option for heavier usage.
