# Activity

Activity has an initial activation and single-QSO slice: activation list/create/read/close,
normalized QSO writes, validity checks, ownership checks, subject aggregates,
transactional event outbox records, idempotency responses, and award recalculation
jobs. Activation resource updates require `status=CLOSED`, and close ignores
`Idempotency-Key`, so repeated closes fail after the first transition as in the
reference. Participant tokens with `identity.me` can list activations only
when filtering by their own operator ID; Activity readers and administrators
retain their broader listing access. Explicit falsey `endedAt` values are
treated as null. Activation owner authorization compares Python `str()` forms
of the authenticated subject and submitted operator ID, retaining JSON float
tokens such as `1.0` as distinct from integer `1`.
Activation operator and authorized callsign normalization also preserves
Python float-token spelling, so JSON `1.0` is rejected as a callsign instead
of becoming `1` through JavaScript string conversion.
Single-QSO writes check `workedCallsign` and `timestamp` with Python truthiness
before activation lookup and return the same ordered `missing required fields`
detail as the reference. Direct QSO writes and queued QSO ingestion preserve
Python string coercion for JSON float tokens in `workedCallsign`,
`workedLocator`, `hunterId`, and `workedEntityId`; ingestion retains float-token
metadata through the Activity JSONB job payload and worker read, with exact
integer and float-token parsing from PostgreSQL JSONB text. Activity job
creation and status responses preserve those numeric tokens as well. Single-QSO
award-recalculation jobs retain a null `hunterId` entry in `subjectIds`, as the
Python handler does. Batch QSO recalculation jobs filter raw Hunter IDs using
Python truthiness and preserve their submitted values. Band and mode
normalization and validation details use Python string conversion for
non-string JSON values. Activation
validity defaults come from
`programmeRules` only, even
when validation uses the `rules` alias. Timestamp normalization accepts lowercase `t`, ISO week dates,
one-character date/time separators, and fractional-second time-zone offsets
supported by Python's
`datetime.fromisoformat`; Activity tests cover date-only, ISO week, compact
offset, fractional offset-second, and invalid lowercase-`z` cases. A Python
fixture also verifies QSO normalization and the SHA-256 deduplication key;
activation validation tests cover rule fallback, location bounds, callsign
authorization and lifecycle; evaluation tests verify violation ordering and
falsey end times. ADIF tests cover multiple records, field mapping, date/time
composition, and omission of incomplete records. The PostgreSQL-backed HTTP
integration fixture uses a real Identity-issued operator token to create an
activation, record a QSO, and close the activation through Gateway to the
Activity API and its separate owner database.
Activation validation also preserves the Python handler's order: earlier rule
and callsign checks run before the `startedAt` lookup, whose omission maps to
the reference's 404 missing-key response. Truthy pair iterables for `location`
and `programmeRules` are converted with Python-compatible `dict()` semantics.
QSO ingestion requests also persist bounded,
owner-scoped jobs with a status read path. `sourceFormat` defaults only when
omitted and otherwise reaches the worker unchanged, matching the Python
handler. The worker normalizes every submitted record before it locks and
checks the activation status and validity window, preserving the Python worker's
error precedence for mixed-invalid batches. The separate Activity worker
consumes its six registered JetStream
durables with database leases, progress acknowledgements, retries, and
dead-letter state. Optional work correlation IDs follow the work-command
schema's 200-character limit. Invalid work envelopes are dead-lettered without
a work ID or work type, matching the Python consumer. Activity notification events use a
separate durable consumer. It parses broker envelopes with exact JSON integers
so Python-style string conversion and dead-letter persistence retain their
submitted values. CI verifies replica sharing, durable resume across a
single-server JetStream restart with retained file storage, confirmed ACKs, and
duplicate-event idempotency. Cluster failover and database-outage recovery
remain open. QSO correction requests and administrator review are also
implemented, ignore `Idempotency-Key` as the reference does, and rely on the
database relation for request QSO existence.
Correction request and review required fields use the reference's ordered
`missing required fields` detail before their corresponding authorization step.
Applied corrections update only the reference's writable QSO fields and queue
award recalculation for the stored QSO, even when the nested route QSO ID differs;
a focused repository fixture covers that transaction and job payload. Correction
timestamps use Python truthiness before parsing, so falsey values clear the
timestamp. Correction requester ownership compares Python `str()` conversions
on both IDs, including JSON float tokens such as `1.0` versus integer `1`.
Proposed correction values preserve exact integer and float tokens from JSONB
through review and response serialization.
The target adds an Activity-admin-only paged correction inbox, filtered by
status and programme and joined to the affected QSO context. This is a target
API extension that makes pending review requests discoverable.
Activity JSONB records, request idempotency responses, and award event payloads
also preserve exact integer tokens at the persistence boundary, matching
Python's arbitrary-precision JSON integers. Activity and award API reads parse
JSONB text directly so those values remain exact through response and replay.
Statistics rebuilds keep PostgreSQL aggregate counts exact when storing metric
snapshots, and statistics reads parse those JSONB values without JavaScript
number rounding. Activation, QSO, subject-fact, and leaderboard count fields
also convert PostgreSQL `bigint` values to exact JSON integers.
Administrator access and
required-field validation order also match the reference. Missing activation,
ADIF import, work job, and correction lookups preserve the reference's quoted-ID
404 detail, including malformed
activation, import, correction, and job IDs before PostgreSQL UUID casting.
Missing award definition, asset, request, issuance, and award-job lookups use the
same detail for missing records. Award definition draft, review, publish, and
retire APIs are implemented.
Award progress reads and
evaluation/recalculation job APIs persist versioned progress and qualification
notifications through the Activity worker. The worker parses award definition
and issuance JSONB text exactly when loading evaluations and render jobs.
Evaluation-job self-access compares
Python `str()` conversions of account IDs, retaining JSON float tokens such as
`1.0` as distinct from integer `1`. Award requests validate eligibility;
issuance is transactional and permanent, and PDF render jobs store artifacts in
S3-compatible storage with authorized presigned download URLs. Qualification
notice payloads and deduplication also preserve the worker split: recalculation
notices include `awardCode` and eligible-level IDs in dedupe keys; direct
evaluation notices omit `awardCode` and key by award, version, and subject.
Cross-service notices resolve Identity events to account IDs and Geodata
decisions to proposer IDs, converting the selected recipient with Python
`str()` semantics. Their stored payloads contain only event type and ID.
The Admin can
render transient PDF previews from mock data and registered assets without
creating an issuance or object; preview and issuance use the same renderer.
Preview requests enforce the reference's 64 KiB declared-body limit before
JSON decoding, returning `preview design exceeds 64 KiB` when exceeded.
Award definition saves and eligible award requests return HTTP 201 when created
and 200 when they return an existing record, matching the reference handlers.
Optional preview artwork and signature inputs use the reference's truthiness
defaults, so falsey values behave as absent.
Registered award assets and bounded content storage are implemented. Award
image uploads authorize the caller and validate the declared media type and
20 MiB body limit before reading the body, matching the reference's request
processing order. Media type validation converts non-string JSON values with
Python `str()` semantics, so array values are not accidentally accepted by
JavaScript's array-to-string conversion.
asset dimensions use Python integer conversion, including float truncation,
boolean inputs, and strict parsing of numeric strings. Paged asset, request,
and issuance lists use the same timestamp ordering columns as the reference.
condition operators default to `GTE` only when omitted; an explicit `null` is
an unknown operator and evaluates false. Entity-type comparisons also preserve
Python's absent-versus-null string conversion and iterable handling. `AND`,
`OR`, and `NOT` preserve Python truthiness, iteration, and omitted-versus-null
behavior for nested conditions. Award asset IDs and recalculation subject lists
use Python truthiness defaults, issuance defaults `dateObtained` only when the
field is omitted, and award-definition optional fields retain explicit null
values where the reference uses dictionary defaults only for omitted fields.
Award evaluation stringifies an explicit null metric as Python `None` instead
of replacing it with the default metric.
Award request IDs, subject IDs, and signature asset IDs are passed to the
reference lookups without JavaScript string coercion. Award categories use
Python `str()` conversion before uppercasing, and definition signature asset
IDs retain the submitted value for registry lookup. Certificate element
labels and kinds plus print page and orientation settings also use Python
`str()` conversion, with defaults applied only when fields are omitted.
Preview name and manager labels use Python truthiness and `str()` conversion;
preview DPI accepts the reference's finite fractional values in the 150–300
range.
Issuance preserves the submitted `dateObtained` value and defaults it only
when omitted; certificate rendering converts award values and element-label
fallbacks with Python `str()`.
Award-request fact lookup passes stored programme and category values through,
with `HUNTER` used only when the stored category is absent.
Award recalculation preserves the submitted subject list in the queued payload;
the worker filters it using Python truthiness and Python `str()` before sorting
the subjects it recalculates. The deterministic idempotency key uses the same
Python conversion and sorting. Worker award-ID filters use Python truthiness
and `str()`, and rule-version filters use Python `int()` conversion.
ADIF uploads use the reference's shared `MYOTA_UPLOAD_MAX_BYTES` cap (25 MiB by
default), then pass authorization, malware checks, and object storage before
durable queueing; the Activity worker enforces the same cap, parses records,
records successes and rejects, updates aggregates, and reports import status.
ClamAV failures remain fail-closed. ADIF and award-asset uploads map scanner
failures to HTTP 400, matching the Python handler's scanner `ValueError`; no
upload is stored or queued after an API scanner failure. When ClamAV fails
during queued ADIF processing, the worker records the shared scanner error
`malware scanner is unavailable; upload was not stored`, matching the Python
worker's persisted import error and notification reason.
The HTTP JSON body limit defaults to 1 MiB for Identity, Programmes, and
Activity, and 1 GiB for Geodata, matching the reference services.
`MYOTA_MAX_BODY_BYTES` overrides the limit per service. Identity's image-based
deployment raises its limit to 32 MiB, matching the reference image deployment.
CSV file uploads now validate bounded
UTF-8 input and queue normalized rows through the same ingestion job. Base64
decoding for CSV and ADIF uploads matches Python's strict validation, which
accepts non-zero unused padding bits.
CSV QSO ingestion is an addition to the legacy behavior: the Python Activity service
exports public results as CSV but has no CSV QSO ingestion route. Track it as an
extension, not as parity evidence. Remaining
Activity notification producers cover ADIF completion and award qualification;
the durable consumer handles cross-service Identity and Geodata decisions.
ADIF validity-window handling aborts the full import before writing QSOs when
one is outside the activation window. The Nest worker commits the import's
`PROCESSING` state before batch work, then retries the work job and dead-letters
it at the delivery limit, leaving the import `PROCESSING` as the Python
reference does. A closed activation follows the same reference boundary:
normalized records fail the insert and retry the job, while an import with no
normalized records can complete with its rejected-row errors. The persisted
`recordsRejected` value uses the Python worker's formula
`recordsSeen - recordsAccepted + normalizationErrorCount`, including its
additional count for normalization errors. ADIF-triggered award recalculation
uses the Python batch key `batch:<activationId>:<firstQsoDeduplicationKey>`.
CI kills an Activity statistics-rebuild worker after it claims a job, expires
the lease, and verifies the reclaimed job completes with the expected summary
snapshots. This qualifies database lease takeover for one Activity job kind;
broader compatibility and broker-outage recovery qualification remain
outstanding.
Failed or queued Activity jobs can be redriven by administrators with
an audited reason. Failed-job redrive preserves the delivery-attempt counter,
matching the pinned Python repository. Long-running Activity jobs now extend their 120-second leases
from a separate database connection while processing. Statistics listing and rebuild-job APIs,
transactional snapshot rebuilds, and owner-scoped notification reads are
implemented. ADIF import creation, processing, and status reads are implemented.
The pinned Python handler returns QSO-ingestion, statistics-rebuild, and award
job status, plus ADIF import status, without checking authorization. Award job
reads also resolve only `jobId`, ignoring nested award and issuance IDs. Nest
preserves that behavior. These reads therefore differ from the OpenAPI bearer
declaration, as they do in the Python implementation.
For early ADIF failures, the worker writes the notification under the
activation ID, as the pinned Python worker does; the notice therefore does not
appear in the activation owner's account feed. Missing-object notices also
retain the Python reason string `object unavailable`. A focused S3 read-failure
fixture verifies that storage errors follow Python `ObjectStore.get` behavior:
the import is marked failed, counted as one rejection, and notified under the
activation ID. Broader Activity compatibility and outage/recovery qualification
remain outstanding.
Activity activation history, public activation history, and statistics pages
apply database limits and offsets while retaining their existing page metadata;
public result exports remain complete exports. The private activation and
statistics pagers read their count and page rows from one read-only
repeatable-read snapshot, keeping totals consistent with the returned page
under concurrent writes.
Public leaderboard category values are uppercased and passed through to the
aggregate query, matching the reference: unrecognized categories return an
empty `items` array instead of a validation error; an absent or blank category
defaults to `HUNTER`.
The notifications endpoint preserves the reference's unpaged `{ items }`
response, falls back to the caller's subject when `recipientId` is absent or
blank, and ignores `page` and `pageSize` query parameters. The Admin Activity
view requests that response without adding page controls or inferred metadata.
Statistics rebuild requests deduplicate by programme and UTC day, ignoring a
caller-supplied `Idempotency-Key`, as in the reference implementation.
The Admin Activity page opens activation details and normalized QSOs, provides
independent bounded paging for activation history and programme-scoped
statistics snapshots, and allows Activity administrators to queue and inspect
rebuild jobs. It also lists notifications for the signed-in account. These
controls follow the read and admin scopes enforced by the API.
Activity entity-deletion impact reads and idempotent cascades also remove
linked QSOs and correction rows, rebuild subject aggregates, invalidate affected
activations, and enqueue award recalculation jobs. Cascade requests apply Python
truthiness and string conversion to `entityId`, while preserving a truthy
`deletedBy` body value without coercion.
The cascade API response includes `activationCount`, while its
`activity.entity.cascade-deleted.v1` event omits that field, matching the
reference's separate response and event payloads.
Award lifecycle, request, issuance, asset, activation-evaluation, and ADIF
import timestamps preserve the reference's six fractional-second digits using
independent UTC clock reads.
