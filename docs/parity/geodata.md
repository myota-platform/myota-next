# Geodata

Geodata deletion now calculates impact, requires explicit confirmation, invokes the
Activity cascade with a stable idempotency key, and transactionally removes Geodata
references and the entity. Import preprocessing, promotion, deletion, and location
enrichment now consume their registered JetStream durables and claim only the referenced
Geodata job. Long-running import, promotion, and deletion work extends owner-database
leases and JetStream acknowledgements.

A bounded reconciler republishes stale queued work and expired leases through the
transactional outbox. Scheduled retention removes eligible import history and owned
source objects, expires stale multipart uploads, and preserves materialized entities.
Activity deletion-impact counts preserve exact PostgreSQL integers through the Activity
response and Geodata's stored confirmation job. CI restarts a single-server JetStream
with its file store retained and verifies the live Geodata worker resumes all four
registered work durables.

A separate three-node JetStream case holds a delivery on each durable while the leader
stops, then verifies all four handlers complete and settle through the replacement
leader. Repository processing is stubbed in this broker-settlement check. Other database
outage cases and Geodata processing outages remain open. A live PostgreSQL service
restart while preprocessing work is pending also verifies claim retry and
acknowledgement after reconnection.

Process outages during other Geodata operations remain open. Deletion-job creation
reports missing fields in reference order, resolves the entity before checking GIS
authorization, and checks global-role eligibility before requesting Activity's impact
summary. Creation and update timestamps use separate clock reads, as in the reference.
Deletion-job reads resolve the job before checking GIS authorization. Confirmation
reports missing fields in reference order, converts the confirmation value with Python
`str().upper()`, and checks job-scoped GIS access after resolving the job; the
confirmation actor does not need `activity.admin` because the queued worker uses the
authorized context recorded with the job.

Confirmation idempotency replay follows required-field and confirmation checks, job
lookup, and GIS authorization. Activity lease extension is supported for long-running
jobs. Geodata's PostGIS Maidenhead-cell function is checked in CI against the reference
Python outputs for point, contained polygon, boundary-crossing polygon, and line
fixtures. CI applies all three owner baselines to three separate disposable databases,
then runs the cell check against the PostGIS database.

Activity subject aggregate counts preserve PostgreSQL bigint precision in API facts and
persisted award progress; award comparisons apply Python-compatible float conversion
without first truncating the database values to JavaScript safe integers.
Location-enrichment workers check the request ID, geometry hash, and terminal status
before calling the provider, so stale requests and redelivered completed or failed work
do not repeat reverse-geocoding lookups.

The repository sets the Geodata writer fence for API requests, claims, and both
stale-geometry supersession paths. The live recovery fixture exercises an API enrichment
request against the fenced entity table, both the pre-provider stale check and geometry
changes during provider lookup, then verifies terminal states and outbox events. Tagged
load-test cleanup now requires explicit environment opt-in, global operator
authorization, exact confirmation, terminal work, safe object scope, and a
no-Activity-impact check before deletion.

Geodata provides PostGIS-backed public entity list/detail reads with filters and bounds,
the import adapter catalogue, provider-derived location options, and authorized
import-run list/status reads; authenticated audit reads and GeoJSON vector tile
collections are also implemented with the legacy tile metadata and feature selection
behavior. Entity responses source both top-level and nested location fields from the
current relational columns, so manual edits and provider enrichment appear in the same
locations as the Python entity projection.

Bounding-box coordinates use Python-compatible float conversion and ordering checks;
accepted non-finite values reach PostGIS as in the reference handler. Reverse-geocoder
subdivision and county deduplication uses the shared Unicode case-fold mapping, and
adapter keyword matching uses locale-independent lowercasing, preserving the Python name
comparisons. Provider requests round representative coordinates to five decimal places
before lookup, as the Python worker does.

The persisted `provenance.reverseGeocoding` record uses the normalized location fields
and includes the raw response only when the provider returned a payload, matching the
Python result shape for success and failure. The city field falls back to locality using
Python truthiness, and administrative name/code selection follows the same
first-truthy-value rule. `geocodedAt` is assigned after the provider response is parsed,
matching the Python lookup timestamp.

`BIGDATACLOUD_TIMEOUT_SECONDS` uses Python-compatible float parsing and preserves
positive fractional values to millisecond resolution. Timeouts above Node's per-timer
limit use chained timers, so the worker does not silently replace long configured
timeouts with 10 seconds. Malformed timeout text follows the reference's startup-time
float conversion; non-positive or non-finite timeout values fail enrichment. Malformed
provider URLs follow the same failed-enrichment result path as provider request
failures.

The worker caches successful and failed provider results by rounded coordinates and
locality language, with a 2,048-entry per-process LRU limit. Adapter fixtures cover
unsupported format rejection, OpenStreetMap tag filtering, ArcGIS FeatureServer point
conversion, and the existing EPSG:3031 projection path. JSON GeoJSON, WFS GeoJSON, and
ArcGIS FeatureServer JSON import creation stores normalized GeoJSON source documents in
S3-compatible storage and queues idempotent import runs transactionally.

ArcGIS geometries with WGS84 and Web Mercator spatial references are normalized to
WGS84; other EPSG WKIDs use the bundled 4,758-entry Proj4 definition table. Spatial
reference selection prefers `wkid` over `latestWkid`, and unsupported projections use
the normalized `unsupported CRS EPSG:<id>` error. WGS84 input retains extra ordinates,
the Web Mercator special case emits XY only, and other projected CRS transforms preserve
ordinates beyond XY, matching the pinned Python path.

Geometry bounds use Python-compatible chained comparisons, so non-finite transformed
coordinates such as `NaN` are rejected. Web Mercator exponential overflow rejects the
feature as in Python. Pasted KML and GPX are converted to GeoJSON with XML document
types rejected and bounded feature/coordinate counts. Queued KML and GPX uploads that
contain no supported feature complete with zero features, matching the reference
streaming importer.

GPX text properties retain XML text-presence semantics: whitespace-only values become
empty strings and can replace earlier values. KML coordinates and GPX coordinate
attributes use Python-compatible float parsing, including its rejection of blank values
and non-decimal forms that JavaScript would coerce. `NaN` and infinity remain parseable
floats and are reported later as per-feature WGS84 geometry errors, as in the reference.

KML continues to use the first direct `name` element. Resumable KML and GPX uploads are
streamed from object storage through a SAX parser, verify the completed source hash, and
apply the configured upload, per-feature, feature-count, and vertex limits while sending
worker heartbeats. GPX uploads emit waypoint and route point features before
track-segment features, matching the Python iterator; track features are spooled to disk
to keep memory bounded while preserving non-finite coordinate values, and feature-size
checks use Python-compatible compact JSON bytes.

A Linux RSS qualification checks 50,000 features in each format against a 96 MiB Node
RSS-growth limit. The Python reference uses the same feature counts and a 96 MiB
absolute process-RSS limit, so the measurements are not directly comparable. Resumable
uploads stream GeoJSON and WFS GeoJSON features through the worker parser and normalize
ArcGIS FeatureServer JSON records before adapter processing. Bounded Shapefile ZIP
uploads require matching sidecars (`SHAPEFILE`, `SHP`, and the legacy `PARKSERVE_US`
format alias); Shapefile member extensions and matching sidecars are case-insensitive as
in PyShp.

Shapefile coordinates are reprojected from the supplied `.prj` to WGS84, and NULL shape
records fail preprocessing with PyShp's GeoJSON conversion error. Its PyShp 2.3.1
fixture is at `apps/geodata-worker/src/fixtures/python-null-shapefile.zip`. OSM PBF uploads are decoded
by `osmium-tool` in the Geodata worker image, preserve OSM tags and type/id source
references, and emit the configured hiking, protected-area, point, path, and
multipolygon features using a temporary disk-backed node-location index. The worker
parses emitted integer tokens exactly, so large OSM IDs retain their Python-compatible
`sourceRef`, feature ID, and source hash.

The checked-in OSM XML/PBF fixture covers tagged nodes, linear and closed ways, a
multipolygon relation with an inner ring, filtering, output order, and source hashes
against the Python importer. A separate PyOsmium 4.3.2 fixture verifies that one
closed way tagged as both `highway=path` and `leisure=park` emits both the line and
area features with the same source ID and Python-compatible hashes
(`4f48466d265151367f2ace4ac6286af815e5b2bccfa74d4cbe381277e713a3e5` and
`ddc69af65206ffd17949c1c0dc70ab83781a36579a6550e715891c277c23e398`). A further
PyOsmium 4.3.2 fixture verifies a `route=hiking` way without a `highway` tag is
imported as a `LineString` with hash
`2d72daf72126a5e207880d327a13916f5d9b48806a02cec51bf3cc18dd8b7718`. The manually
triggered Operational and performance qualification workflow decodes generated
50,000-feature, 250,000-feature, and
300,000-feature PBFs and checks that Linux Node plus `osmium` subprocess-tree RSS growth
stays within 96 MiB, 192 MiB, and 192 MiB, respectively, above the test-worker baseline.
The manual runner now executes all three memory cases instead of returning success
with the qualification skipped.

The 50,000-feature case matches the Python stress fixture's count and limit, but
measures a different RSS scope; the values are not directly comparable. The 300,000
PBF's resource workload contains tagged nodes. Checked-in geometry fixtures cover ways,
a protected-area multipolygon with an inner ring, and a Python-generated multipart
multipolygon with two disjoint outer components and one inner ring. Its PyOsmium 4.3.2
feature hash is `667e7748be2bab9cb530e1a05342c819bb7a9239858daaddbb593c6eef9db968`.
The PyOsmium 4.3.2 `python-osm-tag-matrix.osm.pbf` fixture exercises each of the
nine required tag values on nodes and the five accepted linear-way tags, plus
the remaining area-tag values on closed ways. All 17 emitted Point,
LineString, and MultiPolygon features match the Python importer in order,
source reference, properties, geometry type, and SHA-256 feature hash.
Inputs above 300,000 features and less common OSM relation/member patterns
still need qualification. Area and way vertex limits use the
reference errors; the CLI decoder checks after osmium emits a record, bounded by the
decoded feature-size cap, while PyOsmium checks areas before GeoJSON materialization.

The same manually triggered workflow streams a generated 300,000-feature GeoJSON
FeatureCollection through the metadata scan and feature pass, with Node RSS growth under
160 MiB; a top-level feature array has a separate correctness fixture. The Python stress
fixture uses the same GeoJSON feature count and a 96 MiB absolute process-RSS limit,
while the Nest check measures growth from its test-worker baseline, so these RSS values
are not directly comparable.

The stream regression check guards that current feature source JSON is released as each
item is consumed. CI also streams a PyShp 2.3.1 generated Shapefile with 50,000 records
and checks that Node RSS growth stays within 96 MiB while preserving the first and last
DBF names. The Python Shapefile fixture uses the same record count and absolute
process-RSS limit; the Nest test measures growth above its worker baseline, so those RSS
values are not directly comparable.

Shapefile and PBF working directories use `MYOTA_UPLOAD_SPOOL_DIR` when set, and
otherwise use the OS temporary directory. PBF source bytes stream to disk with checksum
verification. API admission and worker decoding share the same configured upload cap,
defaulting to 1 GiB or the optional format-specific override. PBF output is streamed one
feature at a time, bounded by the per-feature and total-feature limits, into staged
batches bounded by `MYOTA_IMPORT_BATCH_SIZE` and `MYOTA_IMPORT_BATCH_BYTES` (100
features and 32 MiB by default), with the configured per-feature byte limit (16 MiB by
default), 250,000 vertex limit, and configured feature cap.

KML and GPX uploads use the shared upload cap, validate their source hash as the worker
streams, and yield placemarks, waypoints, or track segments incrementally. GeoJSON and
WFS multipart uploads stream their source and yield one parsed feature at a time; ArcGIS
FeatureServer uploads use the same streamed JSON parser and normalize each record before
staging. These formats use the shared API/worker 1 GiB upload cap or optional
format-specific override, 16 MiB per-feature size by default, 250,000 vertices, and the
configured feature count.

Resumable raw upload parts use `MYOTA_UPLOAD_PART_MAX_BYTES` as the request parser and
service cap; empty and oversized parts return the same `upload part must be between 1
and <limit> bytes` validation detail as Python. Empty and oversized raw parts are
rejected before authorization, matching the reference's request-body parsing order. For
accepted parts, the owner-scoped session and expiry are resolved before checksum
validation.

Inactive and expired sessions retain the Python handler's 400 status and detail. The
response's suggested part size retains the reference's 5 MiB S3 minimum even when the
configured hard limit is lower. Missing upload sessions and import-processing queues
preserve the quoted `KeyError` detail used by the Python handlers. Upload status reads
include `importRunId` only for completed sessions, as the reference response does.

`GEODATA_MAX_IMPORT_FEATURES` uses Python-compatible integer parsing in both API and
worker, including zero and negative limits; malformed values fail instead of silently
falling back. The `MYOTA_IMPORT_MAX_FEATURE_VERTICES` and
`MYOTA_IMPORT_MAX_SHAPEFILE_EXPANDED_BYTES` settings use the same parser and control all
format vertex limits and Shapefile expanded size (250,000 vertices and 1 GiB by
default). The shared `MYOTA_IMPORT_MAX_FEATURE_BYTES` setting controls decoded feature
size in GeoJSON, KML/GPX, Shapefile, and PBF imports (16 MiB by default).

Prepared candidates and validation errors are staged by import attempt in Geodata
PostgreSQL; candidate creation, import status, processing queue, and the compatible
outbox event are finalized atomically, with event arrays assembled in the database.
Finalization's discarded-record and processing-queue totals preserve exact PostgreSQL
integers through the response and outbox payload. Import promotion summaries also
preserve exact PostgreSQL created, updated, and remaining counts in persisted
statistics.

Import staging counts and source-manifest record totals avoid 32-bit casts. Import
status reads parse the JSONB projection as exact-integer JSON, preserving large
candidate totals and statistics through the API response. Entity and import status reads
reject malformed IDs before PostgreSQL UUID casting. Missing entity reads, imports,
conflation candidates, deletion jobs, and refresh schedules retain the reference's
quoted-ID 404 details; processing queue reads retain their fixed quoted missing-queue
message.

Literal missing import-run errors preserve their quoted messages as well. Record hashes
use Python float formatting and Unicode code-point key ordering. Direct and streamed
GEOJSON/WFS imports preserve exact integer tokens through source storage and worker
decoding, while retaining raw numeric tokens in feature hashes and injected root CRS
values within the configured decoded-size limit (`MYOTA_IMPORT_MAX_FEATURE_BYTES`, 16
MiB by default).

Root CRS selection follows the streaming reference's first-value behavior, including its
fallback to `spatialReference` only when the first `crs` value is absent or null;
captured integer values remain exact. Streamed root geometry documents converted into
Features retain those tokens as well. Direct ArcGIS FeatureServer imports hash raw
source records before API normalization. The scheduled Node importer preserves source
numeric tokens in the generated Feature hashes it submits.

Streamed imports reject features whose inherited CRS pushes their decoded size over the
reference's configured limit. Generated PBF hashes now retain Python float formatting
for geometry coordinates. Shapefile source hashes use original coordinates, DBF numeric
field types, and source `.prj` text; the adapter applies the CRS transform once during
normalization. Binary-format integer attributes are staged without precision loss,
including values beyond JavaScript's safe integer range.

Geodata PostgreSQL pools preserve those values on reads, and the API returns them as
numeric JSON tokens. Generic projected CRS transforms preserve ordinates beyond XY, and
unsupported CRS identifiers use the reference domain error; the reference's Web Mercator
special case emits XY only. Hash and feature parity has PyShp-generated point fixtures
for WGS84, uppercase sidecar extensions, and Web Mercator. The projected fixture checks
the original-coordinate source hash and one adapter reprojection against PyShp 2.3.1 and
PyProj 3.8.0.

The baseline fixture also covers a large-integer DBF field, `.prj` text, and canonical
source hash. The PBF suite also compares a disjoint multipart relation and its inner
ring against the PyOsmium 4.3.2 reference output and hash. Other less-common PBF
geometries and CRS definitions still need fixtures. The
direct JSON import path materializes the normalized collection and accepts the
reference's feature arrays, single geometries, geometry wrappers, and empty collections,
while multipart GeoJSON streams source features. The streaming worker selects a root
`features` array directly, matching the Python `ijson` path.

A `FeatureCollection` without a features array returns the reference's specific
validation error. The PyShp 2.3.1 MultiPointZ fixture verifies GeoJSON dimensionality:
PyShp's `__geo_interface__` emits XY coordinates for this shape type, and the Nest
streaming reader matches it. A nested Polygon fixture verifies that the reader preserves
PyShp's MultiPolygon grouping, including an interior ring and an island inside that
ring.

The PyShp 2.3.1 reference rejects MultiPatch with `Shape type "MULTIPATCH" cannot be
represented as GeoJSON.` The NestJS Shapefile parser rejects shape type 31 at file open,
and the worker maps that error to the same message. Its reference-generated fixture is
at `apps/geodata-worker/src/fixtures/python-multipatch-shapefile.zip`. See the [PyShp 2.3.1 conversion
code](https://github.com/GeospatialPython/pyshp/blob/2.3.1/shapefile.py#L3174-L3176) and
the [NestJS parser's supported shape
types](https://github.com/mbostock/shapefile/blob/master/shp/index.js#L11-L24).

A PyShp 2.3.1 `PolylineZ` fixture also confirms that both the reference
`__geo_interface__` and the Nest streaming parser drop Z ordinates and expose a 2D
`LineString`; the fixture is checked in at
`apps/geodata-worker/src/fixtures/python-polylinez-shapefile.zip`.

A PyShp 2.3.1 multipart `PolyLine` fixture confirms that both parsers retain the two
parts as a `MultiLineString` with the same coordinate grouping; it is checked in at
`apps/geodata-worker/src/fixtures/python-multiline-shapefile.zip`.

Separate PyShp 2.3.1 `PolyLine` and `MultiPoint` fixtures cover their ordinary
2D shapes, including single-part `LineString` and XY `MultiPoint` outputs.

A simple PyShp 2.3.1 `Polygon` fixture also confirms that a single exterior ring stays a
GeoJSON `Polygon`; it is checked in at
`apps/geodata-worker/src/fixtures/python-polygon-shapefile.zip`.

Additional PyShp 2.3.1 `PointZ`, `PointM`, `PolylineM`, `PolygonZ`, `PolygonM`, and
`MultiPointM` fixtures confirm that both parsers drop extra ordinates and preserve the
2D geometry types and part grouping. Along with the base Point, PolyLine, Polygon,
MultiPoint, and multipart fixtures, these cover every supported PyShp shape family;
Null and MultiPatch are explicitly rejected with the reference errors.

Shapefile multipart uploads stream to temporary disk and decode records one at a time,
with the same shared API/worker 1 GiB upload cap or optional format-specific override, a
1 GiB expanded-size cap, 16 MiB per-feature size by default, 250,000 vertices, and the
configured feature count. Less common geometry layouts and CRS transformations that
depend on datum grids beyond the Spanish ED50 grid still need compatibility qualification
against the reference parser.

Thirteen EPSG coordinate fixtures compare with PyProj 3.8.0 within `1e-7`
degrees, including the Python import path's EPSG:25830 point at `(-5.99, 37.39)`.
EPSG:4230 and projected ED50 EPSG:23028 through EPSG:23038 use the IGN Spain
ED50-to-ETRS89 grid when the fallback coordinate is within its geographic
coverage. PyProj 3.8.0 Spain-specific operation fixtures for EPSG:4230 and
EPSG:23029 through EPSG:23031 match within `1e-7` degrees. A PyShp 2.3.1
Shapefile fixture also supplies ED50 as ESRI WKT rather than an EPSG string; the
adapter recognizes its datum and applies the IGN grid. Geographic ED50 WKT uses
the same grid path. This closes a previous mismatch where `.prj` WKT bypassed
the grid and shifted the tested point by about 0.0013 degrees in each axis.
EPSG-tagged WKT2 `.prj` files now resolve their root CRS authority before
projection, including when nested base-geography and conversion-method IDs are
also present. A PyProj 3.8.0 WKT2 Shapefile fixture for EPSG:23030 verifies the
same Spanish-grid output through the streaming importer. A custom ED50 WKT2
Shapefile fixture with all authority IDs removed also resolves its UTM
parameters and matches PyProj's grid transformation; a geographic ED50 WKT2
fixture covers the authority-free geographic form.
Coordinates outside the grid coverage retain the bundled global definition.
The grid's source and CC BY 4.0 attribution are recorded in
`libs/geodata-domain/data/README.md`; other datum-grid operations remain
unqualified. In operation areas that overlap Portugal or other PyProj choices,
the target intentionally selects the Spain-specific IGN grid; this can differ
from the legacy `Transformer.from_crs` default operation and is documented as a
target extension in the [remaining-work ledger](../remaining-work-ledger.md#d-06--geodata-parity-is-qualified-by-material-workflows-and-source-formats).
Geometry type aliases use Python-compatible Unicode case folding, and CRS
metadata selects the first Python-truthy identifier field. Integer-valued floating CRS
identifiers use Python's decimal integer formatting, including values whose default
JavaScript string form uses exponent notation. Geodata coordinate validation also
preserves Python's `bool`-as-number behavior, including numeric-equivalent polygon ring
closure; projected coordinates convert those values before transformation, and streamed
vertex limits count them as coordinates.

Import adapters infer feature names from the reference alias catalogue before
validation, using Python-compatible Unicode casefolding, whitespace collapse, and
300-code-point truncation. Adapter property mappings use the reference's `dict()`
conversion, including iterable key/value pairs. The worker validates WGS84 geometries,
stages candidates with provenance and 50 m duplicate warnings, records errors, and emits
the preprocessing fact.

Conflation name similarity uses Python Unicode casefolding and whitespace stripping,
plus the `SequenceMatcher` popularity heuristic for reference names of 200 or more code
points; signal values use Python's ties-to-even rounding to six decimal places.
Bounding-box centroids are rounded to seven decimal places before distance scoring.
Terminal preprocessing failures emit `geodata.import.failed.v1` atomically with the
failed run state, using the `importRunId` and untruncated error text from the failed
attempt; retryable failures do not emit the fact.

Community proposals join this pipeline, and community proposals and imported features
preserve validated attachment metadata before promotion. Multipart/resumable uploads are
implemented with owner-scoped durable sessions, bounded binary parts, checksum and
malware scanning, and transactional completion up to the worker's configured source
limits. Repeated completion returns the Python handler's full persisted `importRun`
object.

CI's live Admin browser workflow uploads GeoJSON, OSM GeoJSON, WFS GeoJSON, ArcGIS
FeatureServer JSON, KML, GPX, OSM PBF, Shapefile, and ParkServe US ZIP files through
this multipart path and verifies the completed sessions, source object metadata, worker
results, and review candidates. Upload creation checks required fields using Python
truthiness and order, normalizes filename and size before the idempotency lookup, then
replays a matching key by filename and expected size before validating digest, category,
and format details.

New session metadata stores the first normalized category as `entityType`, alongside the
complete `entityTypes` list. Reusing a key with a different filename or expected size
returns HTTP 400. A truthy `sha256` value is converted with Python string semantics
before its hexadecimal digest validation. Multipart upload creation accepts the Python
`JSON` format alias and stores it as `GEOJSON`, including when inferred from the
filename extension.

A truthy format value is converted with Python string semantics before uppercasing.
Local object-size and malware scan failures delete the assembled object and mark the
upload session `FAILED`; scanner service outages leave the completion handoff retryable,
matching the Python error paths. Abort requests mark a session `ABORTED` only after
object storage confirms the multipart abort; storage failures propagate and preserve the
current session status.

For multipart upload scanning, NestJS maps a ClamAV non-2xx response and transport
failure to HTTP 500 with the reference scanner-unavailable detail and uses the
reference's 120-second socket inactivity timeout while streaming the object. Local
malware detection remains HTTP 400. Both paths fail closed before queuing import work.
GeoJSON, Shapefile, and PBF multipart uploads use their larger configurable limits.
Durable object references from the configured import bucket are bounded, hash-checked,
validated, and staged as normalized worker inputs; object keys retain their submitted
value when checked.

Shapefile ZIP intake selects the first `.shp` member and requires matching `.shx` and
`.dbf` sidecars, following the reference importer. Refresh schedules can be listed and
created, and manual complete- snapshot runs queue GeoJSON imports, promote validated
candidates, record manifests, and apply disappearance policy after successful
preprocessing. Import promotion generates deduplicated conflation candidates from
overlapping PostGIS bounding boxes using the baseline 0.55 scoring threshold.

Failed promotion queues can be redriven with a required reason recorded in queue
metadata and the outbox. The Admin now lists filtered, paged conflation candidates and
records decisions, optional survivor selection, reviewer, and note through the audited
API. A live Admin browser workflow checks the saved decision, selected survivor,
reviewer attribution, resolution history, idempotency record, and transactional outbox
event.

Admin users with import scope can also create and page refresh schedules, then queue a
complete GeoJSON snapshot manually. Schedule pages follow the reference mapping's
lexicographic ID order. A separate Node importer polls due schedules and also accepts
the reference `GEODATA_IMPORT_SPEC` one-shot complete-snapshot input. It fetches GeoJSON
or ArcGIS FeatureServer data only from allowlisted HTTPS hosts; it rejects redirects,
enforces the shared GeoJSON source-byte limit while reading, and decodes response bytes
as strict UTF-8 before JSON parsing, as the Python reference does.

Scheduled fetches use the schedule run API; one-shot imports post to the ordinary
complete-snapshot import API. FeatureCollection members are passed through for
per-record handling, and ArcGIS attributes use Python-compatible `dict()` conversion.
The scheduled and one-shot API base URLs remove all trailing slashes, matching the
reference importer's `rstrip("/")` behavior. The shared `GEODATA_MAX_IMPORT_FEATURES`
limit is checked consistently by the importer, API, and worker.

The API retains the reference timestamp updates; the importer calculates automatic
eligibility from `lastRunAt + intervalSeconds`. Import, conflation, promotion,
source-reconciliation, and deletion lifecycle timestamps generated inside database
transactions preserve six fractional seconds with independent UTC clock reads. Entity
review, metadata, geometry, location-enrichment, and refresh-schedule timestamps use the
same formatter.

`GEODATA_IMPORTER_ENABLED` keeps it opt-in. Helm exposes its polling interval and HTTPS
source-host allowlist; production deployment, live-source qualification, and
outage/recovery evidence remain outstanding. See the [importer deployment
guide](../operations/geodata-importer.md). Importer checks fetch allowlisted GeoJSON
fixtures through both the one-shot and scheduled paths. They verify the due schedule
selection, complete-snapshot request, authorization, and idempotency sent to Geodata.

Live source domains and deployment behavior still require qualification. Live browser CI
creates a manual refresh schedule in Admin, runs an empty complete snapshot through
Gateway and Geodata workers, and verifies completion and persisted snapshot metadata.
The API integration fixture also creates a source-backed schedule through Gateway, has
the importer fetch a bounded GeoJSON fixture, and sends its complete snapshot to the
live Geodata API; it verifies the queued import metadata and feature count.

A separate Gateway request check verifies schedule timestamps and outbox events. Live
source domains and deployment behavior still require qualification. Refresh intervals
preserve arbitrary-precision integer values and follow Python `int()` whitespace,
Unicode decimal, underscore, boolean, and float-truncation behavior through API parsing,
persistence, and importer due-time calculation. Multipart upload part numbers follow
Python integer parsing for whitespace, Unicode decimal digits, and underscores before
enforcing the 1 through 10000 range.

Multipart expected sizes follow Python `int()` conversion for booleans, finite floats,
and integer strings with Unicode digits or underscores before the source-specific byte
limit is enforced. Complete snapshot imports are also accepted on the ordinary import
path; the worker applies disappearance policy after the final batch is staged, before
candidate review or promotion, matching the reference worker lifecycle. Disappearance
policy values retain their submitted casing and are checked at snapshot reconciliation
time; malformed values therefore fail worker processing instead of being normalized or
rejected at request creation.

Finalization removes staged candidates and queues transactionally while preserving the
import summary and materialized entities. Pending candidates can be paged;
administrators can confirm or reject selected rows transactionally. Rejection removes
candidates from the review table and retains their IDs and reviewer in the outbox event;
once all remaining candidates are processed or rejected, the import run becomes
`COMPLETED`.

Candidate validation checks required fields first and preserves duplicate IDs in
submitted order; validation status uses Python truthiness and string conversion before
checking supported values. Repository fixtures verify that confirmation deduplicates
database selection while retaining the submitted duplicate order in its response and
outbox event, and that queued records cannot be rejected before any deletion or event
write.

Promotion selection applies required-field checks, validates that the candidate list
is nonempty, then validates `targetStatus`, matching the Python handler's error
precedence. IDs are then sorted and deduplicated before the synchronous 100-candidate
limit is applied, so repeated IDs do not count as additional entity mutations. Admin
promotion of up to 100 candidates is synchronous:
the service walks sorted, distinct IDs and checks existence, review coverage, then
promotion eligibility in the Python handler's order, while deferring writes until every
candidate passes. It applies entity, category, source-link, audit, and outbox writes in
one Geodata transaction and returns the final created and updated IDs. Any invalid,
ineligible, or over-limit selection is rejected without partial promotion. The 100-record
request bound is an initial safety cap; production
capacity qualification must confirm or revise it. Large import intake and preprocessing
remain asynchronous. Automated community-proposal imports may still use the internal
worker promotion queue. A candidate linked to a prior promotion queue can be retried
synchronously only when that queue is failed and records that candidate as failed; the
API locks the prior queue before candidate rows, clears the stale association in the same
transaction, and then promotes it. Active or unrelated queues remain conflicts. Focused
repository tests cover eligible retry, active-queue rejection, per-candidate authorization
order, all-or-nothing selection, and the absence of a new queue. Entity review, metadata, category, and geometry changes,
conflation decisions, and import candidate validation and promotion preserve submitted
notes without coercion or truncation, matching the Python handlers.

Entity review status falls back from `status` to legacy `decision` using Python
truthiness; candidate proposal identity remains in `candidateSource`, and `sourceRef`
uses the normal import fallback. Entity-name edits stringify truthy JSON values with
Python semantics and distinguish missing, whitespace-only, and overlong names. Import
source identity selects `sourceKey`, `url`, then `name` using Python truthiness and
preserves submitted whitespace.

Proposal feature objects follow adapter normalization without an extra `type`
requirement. Falsey feature properties default to an empty object, while truthy
non-object properties are rejected as malformed input. The pinned Python source also
defines and unit-tests `change_geometry_type`, but does not register it in the route
table; the Admin UI changes the GeoJSON type through the registered geometry replacement
route instead.

Accordingly, `geodata.entity.geometry-type-changed.v1` is retained in the copied event
registry as a source-derived schema, but it is not an active HTTP parity requirement;
geometry replacement emits `geodata.entity.geometry-updated.v1`. Proposal and
direct-import idempotency scopes keys by owner and actual request path, fingerprints the
parsed request body before validation, and rejects changed-body reuse while preserving
integer versus float values.

The request lock spans proposal/import validation and source-object, import, and outbox
creation. Import candidate validation now uses the same owner/path-scoped key and
request fingerprint, replays successful results before body validation, and rejects
changed-body key reuse. Import promotion applies the same request contract while
retaining scope checks and atomic queue/outbox writes. Entity review, metadata,
category, geometry, and location-enrichment writes also use the owner/path/body contract
and replay before mutation validation.

Conflation resolution uses the same contract while preserving its transactional history
and outbox write. Refresh schedule creation and manual runs also scope keys by owner and
path, check the request fingerprint before validation, and reject changed-body reuse; a
run replay preserves the prior import and schedule result. Deletion-job creation and
confirmation also replay by owner, path, and body after their source-ordered validation
and authorization checks, including a confirmation retry against an already completed
job.

Import finalization and failed promotion queue redrive use the same request fingerprint
and successful-result replay. Deletion worker leases use the database-generated JSONB
timestamp value for both persistence and lease fencing, preserving the reference
representation instead of reconstructing the deadline from the process clock. Candidate
validation notes are stored as JSONB with existing text values preserved as JSON
strings.

If-Match protected name, website, description, geometry, category, and location edits
are also implemented. Entity status, import candidate, and conflation review actions
have corresponding Admin workflows; broader payload and workflow compatibility
qualification remains outstanding.
