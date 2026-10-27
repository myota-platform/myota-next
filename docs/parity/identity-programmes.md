# Identity and Programmes

## Shared implementation notes

Gateway JSON forwarding and Identity outbox, security-event, evidence, and idempotency
JSONB writes preserve arbitrary-precision integer tokens from the request parser through
serialization, matching Python JSON handling. Security-event feeds, account exports, and
idempotency replays parse stored JSONB text directly, preserving those integers on read
as well. Programme's Core database pool installs an exact integer JSONB parser for
programme records, entity types, policy drafts, content, and idempotency reads.

Shared outbox and security-event occurrence timestamps come from PostgreSQL's
microsecond clock, retaining the reference's fractional-second precision.

Focused Nest email-worker tests now cover the Python worker's allowlisted participant
and administrator commands, rejection of sensitive extra fields and BOM-prefixed JSON,
HTML escaping, and delivery-state persistence before the JetStream acknowledgement.
Duplicate acknowledgement, delayed retry, retry exhaustion, and redacted SMTP error
logging are also covered. The tests also cover cached Identity token use, transient
Identity failure, unavailable recipients, and SMTP configuration validation.

SMTP/TLS handshake behavior is exercised against a local SMTP server: the client
requests STARTTLS, begins the TLS handshake, and sends no AUTH command when that
handshake fails. On 2026-10-26, the deployed Email worker also delivered an
allowlisted participant message to an in-cluster STARTTLS sink using a short-lived
CA mounted from a Kubernetes Secret. Replaying the same work ID resulted in one
captured message and one persisted attempt. The test used a synthetic account and
did not contact an external relay; the direct durable publish did not qualify the
account-creation producer workflow or a production SMTP provider's trust chain.
See [deployed SMTP evidence](../operations/single-instance-restart-recovery.md).
Identity recipient token expiry uses a monotonic clock
measured from before token acquisition, matching the reference cache timing. The cached
lifetime applies Python integer conversion to `expiresIn`, subtracts a 30-second margin,
and clamps the result to 30–270 seconds, matching the Python worker even when Identity
returns a short token lifetime.

Token issuance and recipient resolution require HTTP 200; other successful recipient
statuses are still treated as unavailable, as in the Python resolver.

`programme-policy.service.spec.ts` exercises a rules draft through save, submit,
approval, and publication, including offset timestamp normalization, review history,
rules replacement, policy version increment, and the publication fact. Policy body
validation follows the reference's authorization order, while an unknown-status PATCH
resolves the draft before checking authorization; HTTP fixtures pin both sequences.

`programme-entity-type.compatibility.spec.ts` pins the Python catalog behavior: one
shared category can be assigned to multiple programmes, removing it from one programme
leaves the other assignment intact, all supported geometry types retain their
normalized order, and an existing category code cannot be renamed. The focused
`programmes.service.compatibility.spec.ts` also pins invalid-status precedence and the
archive action's ignored fields, unchanged policy version, and event payload.

The Python reference separately pins the UTC conversion behavior. Content publication
converts `effectiveFrom` with Python `str()` semantics before timestamp parsing,
including floating-point JSON tokens.

The email worker accepts the schema's trailing uppercase `Z` timestamp with
either `T` or `t` as the date/time separator, matching Python's RFC3339
validation. It preserves a leading UTF-8 BOM for `JSON.parse` to reject,
matching Python's `json.loads` behavior. HTML templates use Python's apostrophe
entity (`&#x27;`) when escaping user-provided names.

## Identity

Identity implements password login, refresh rotation, logout revocation, recovery
request/reset, current-account reads, owner-only profile updates, account creation,
administrator account listing, owner/global account reads, and account role reads in
NestJS. Public self-registration now creates only a base `PARTICIPANT` account in an
unverified state, sends a single-use verification link through the Email work flow,
and prevents login until verification succeeds. Responses for registration and resend
are generic; verification tokens are stored hashed, expire after 24 hours, and are
invalidated after use or resend. Requests are rate-limited. `PARTICIPANT_ADMIN` is a
separate system role with participant-account management scope, and its API list/update
operations filter to Participant accounts and revoke sessions on suspension. Focused
Identity and Email worker tests cover these paths. The isolated deployment workflow,
real email route, and browser qualification remain tracked by Phase 6 issues #91 and
#96–#100; implementation in source is not deployment evidence.

The Email worker supplies its validated template ID when resolving an account's
deliverable address. Identity permits an unverified `PENDING_SETUP` account only for
`participant-email-verification.v1`; other pending, deactivated, missing, and
unaddressable accounts continue to share the same unavailable-recipient outcome.

The role catalogue endpoint returns built-in and persisted custom roles under the
existing authorized scopes; custom role creation and partial updates are backed by Core
transactions and security/outbox events. Logout compatibility is covered through the
full token lifecycle: the refresh session and presented access token are revoked, and
the refresh token is then rejected. Invalid refresh tokens remain an idempotent logout.
When a valid refresh token is supplied together with an invalid access token, both the
Python relational operation and Nest transaction roll back the refresh revocation; a
focused Nest fixture pins this failure ordering.

Role definitions sort by code point, matching Python's string ordering for custom codes
containing underscores. Role-definition POST and PATCH authenticate before DTO
validation; PATCH also resolves and rejects built-in definitions before validating the
submitted fields, matching the Python handler's response precedence. Role creation
checks truthy `code` and `name` values before applying Python `str()` conversion; create
and update preserve exact large integers and JSON float tokens such as `1.0` in those
fields.

Falsey custom-role descriptions normalize to the empty string on create and when
explicitly supplied on update, matching the relational persistence path. Empty or
duplicate normalized role codes return the reference's 400 response. An authorized PATCH
for a missing custom role returns the reference's quoted role-code 404 detail. Owner
profile updates authenticate and check revocation and account availability before
validating submitted fields, matching the Python handler's response precedence.

Website URL normalization also removes empty trailing query and fragment delimiters,
matching Python's `urlunsplit` behavior, and rejects URLs without a syntactic authority,
matching `urlsplit` validation. Non-control internal URL whitespace retains the
reference's URL-specific error detail, while control characters and overlong values use
its invalid-or-too-long detail. Role arrays preserve assignment order, including
multi-role replacements that share a creation timestamp.

Role replacement also shares one timestamp between expiring prior assignments and
creating their replacements, matching the Python handler. Administrative account PATCH
and role-assignment PUT authorize before resolving the target ID; malformed or absent
targets return the quoted-ID 404 from the Python dictionary lookup before request-body
validation. These routes preserve profile, password, status, anonymization, and role
replacement behavior in Core transactions. Administrators cannot grant a new role at
equal or higher authority; a global operator also cannot grant the equal
`GLOBAL_OPERATOR` role. The last active `GLOBAL_OPERATOR` assignment cannot be removed.
An Identity administrator can retain or revoke an equal-authority role already assigned
to another account; focused transaction fixtures pin these cases.

As in the reference handler, changing status alone does not anonymize the account or
revoke its sessions; existing refresh sessions also remain rotatable, and both session
revocation and anonymization happen when `anonymize` is true. Password changes and
anonymization refresh `revokedAt` on already-revoked sessions as well, matching the
handler's per-session update. An anonymization fixture also verifies private profile
fields and image metadata are cleared in the database transaction, then the old image
object is deleted only after commit, matching the Python profile-image lifecycle test.
A live Admin workflow now deactivates an account by changing status alone, then rotates
the owner's existing refresh session and verifies the response retains the deactivated
status.

Callsign creation, evidence, verification, primary selection, and retirement also write
to the relational Core model and outbox. Account reads and exports preserve the
reference's callsign, evidence, and security-event insertion order through Core-owned
order values. Existing rows are backfilled chronologically with IDs as deterministic
tie-breakers. Callsign retirement authenticates and resolves the account and callsign
before validating optional fields.

It checks a primary replacement before reading evidence only when retiring the primary
callsign; malformed replacement values are ignored when the target is not primary,
matching the reference's branch behavior. Service fixtures pin that branch order, the
verification-scope check before database access, and the missing-evidence error before
optional review field validation. Callsign create, evidence submission, verification,
retirement, account reads and exports, and outbox payloads preserve PostgreSQL
microseconds in lifecycle timestamps.

Submitted `validFrom` and `validTo` text passes through to PostgreSQL without JavaScript
`Date` truncation. Account creation, login and refresh responses, current-account reads,
profile updates, and administrator account reads also preserve microseconds in account
and profile image timestamps. Role-definition and account-role reads preserve PostgreSQL
microseconds in their creation and expiry timestamps as well. Security-event feeds and
account exports, OIDC mapping creation, role-replacement events, and bootstrap account
creation events preserve those fractional seconds too.

Role replacement uses a single microsecond-precise UTC value for the outgoing and
incoming assignments. Callsign create, primary-selection, evidence, verification, and
retirement defer account-ID resolution until after their respective authorization
checks; a missing account returns the quoted-ID 404 before replaying an idempotent
result or resolving a callsign. Callsign verification authenticates and resolves its
target, then requires evidence before validating the optional verification source,
matching the reference's error precedence.

Callsign creation, primary selection, and evidence submission check required fields with
Python truthiness before authorization, preserving the reference's `missing required
fields` response and precedence. Primary callsign selection rejects malformed IDs with
the same `callsignId is not an active callsign on this account` response as a
non-matching ID instead of exposing a PostgreSQL UUID-cast failure. Administrator
account PATCH and role-assignment PUT authenticate and resolve the target account before
validating the request body, matching the reference's response precedence.

Account-update fixtures pin admin permission denial before account lookup and
missing-account responses before body validation. Account PATCH validates profile fields
before checking email conflicts, then checks email conflicts before validating status
and participation type, matching the reference's field order. When role replacement is
requested, Nest checks `identity.roles.assign` at the replacement step, after
Core-backed account and email-conflict handling; the encompassing Core transaction rolls
back earlier writes if role authorization fails. A focused regression fixture combines a
profile change with an unauthorized role replacement and verifies that the preceding
account write is rolled back and no role write or commit occurs.

The PUT retains its roles-only request shape while deferring DTO validation to that
authorized sequence. Focused Identity fixtures verify profile-image normalization
against Pillow, pin service-token signing to a Python-generated HS256 token (including
Bearer and expiry rejection), exercise callsign normalization, retired-value reuse,
duplicate rejection, and first-primary selection, and pin account-creation permission
and validation precedence plus Identity-administrator role escalation denial to the
Python handler.

`auth.profile.compatibility.spec.ts` compares own-profile updates with the Python
normalization contract: website scheme and surrounding whitespace are normalized,
empty or null values clear fields, and unsafe URLs, unsupported fields, oversized
biographies, and empty updates fail before profile writes and roll back.

Recovery fixtures cover account enumeration behavior, expired and one-time token use,
password length, and session revocation; expired-token rejection leaves credential and
session state unchanged. Login tests verify the eight-attempt general limit and the
global-operator bypass. An account-export fixture now verifies owner scoping before
database access, a repeatable-read snapshot, and stable order across account callsigns,
roles, callsign evidence, and security events. It also checks that evidence metadata and
event payload integers beyond JavaScript's safe range remain exact after export.

Compatibility checks also verify account creators can read role choices without
account-admin access, participants cannot read them, administrators cannot change their
own role assignments, and access tokens stop working after account deactivation. The
Admin account list resolves each subject's active role scopes from Identity, including
the global operator `*` scope, matching the Python list behavior. The pinned handler
test inventory has been compared with focused Nest fixtures and live workflows for
account creation and replay, role authority, callsign lifecycle, profile and image
handling, recovery and session revocation, and Programme catalogue, content, and policy
lifecycle operations. These checks cover the primary workflows and consequential
authorization, validation, conflict, and persisted-state outcomes required by the
[completion criteria](completion-criteria.md). Rare cross-product combinations are not
separately qualified unless comparison identifies a material mismatch. Callsign create
and primary-selection idempotency fixtures also pin the Python order: required callsign
fields precede authorization; authorization and account resolution precede cached
replay; and replay skips mutation-specific validation and leaves the database and outbox
unchanged.

The PostgreSQL-backed Identity HTTP fixture also exercises bootstrap account
provisioning, password login, the authenticated current-account route, and single-use
refresh rotation through the real Nest controller and service. The Gateway-to-Identity
integration creates an account using an email with surrounding whitespace and mixed
case, then verifies normalized email, `PENDING_SETUP`, the default `PARTICIPANT` role,
and exact idempotent replay.

The live API suite includes two concurrent account creations using differently cased and
spaced forms of the same email, checking that exactly one account is persisted and the
losing request receives the reference duplicate-email detail. The first isolated CI run
did not exercise the race because the fixture used the unsupported `INDIVIDUAL`
participation type. With the supported `OPERATOR` type, the live test passed against
isolated PostgreSQL: one request returned 201, one returned the duplicate-email 400, and
exactly one account row was persisted ([CI run 39968418850](https://github.com/myota-platform/myota-next/actions/runs/39968418850)).

Live CI also retries account creation with the same idempotency key and body after the
first commit. It compares the full response and verifies the retry creates no extra
account, security event, or account outbox event, pinning idempotency replay before the
duplicate-email check.

It also confirms that account creation rejects a permanent password with the reference's
invitation-setup detail. The same live integration activates the account, requests and
consumes a recovery token once, then signs in with the new password. A live Admin
browser flow also creates a participant through Gateway, verifies the returned account
and pending setup message, grants an additional permitted Activity role, and confirms
the account appears in the refreshed list.

### Phase 6 deployed Participant password-reset checks — 2026-10-27

The Participant password-reset request form was exercised against `myota-test` using a
synthetic account and the test-only Mailpit SMTP sink. The browser displayed the generic
“If an account matches that address” response, one reset email reached the configured
test mailbox, and the test removed that message afterward. A separate API check completed
the reset flow, confirmed the previous access and refresh credentials were rejected
(HTTP 403), signed in with the replacement password, and restored the synthetic account's
original password. Its generated Mailpit messages were removed. The scripts and account
fixture are local test artifacts and are not committed.

This verifies the request UI and delivery to the local test sink, plus API password/session
behavior for the deployed Identity service. A deployed browser check submitted an invalid
reset token: Identity returned HTTP 400, the token was absent from the URL and app asset
`Referer`, and the UI presented a recoverable message with the reset-request form
available. A full valid-link browser journey also passed: the browser requested a reset,
opened the actual Mailpit-delivered link in a fresh page, cleared the token fragment,
accepted a new password, and signed in with it. A second delivered link restored the
original password, which then authenticated successfully. Both generated reset messages
were removed.

On 2026-10-27, the expired-link path was verified with the actual Mailpit-delivered link
for the synthetic account. The corresponding Core recovery-token row alone was expired in
the test database to avoid waiting through the configured token lifetime. The browser
received HTTP 400, showed the invalid-or-expired message and recovery-request form,
removed the token fragment, and did not include the token in the app asset `Referer`.
Login with the synthetic account's original password still succeeded afterward; the
temporary verification session was logged out. The generated Mailpit message was removed.

The same day, six sequential reset requests from one test source to a unique nonexistent
`example.test` address all returned HTTP 200 with the same generic `accepted` response
and no development token. The Core limiter recorded six attempts in its 15-minute window;
no recovery request or email was created. The temporary limiter row was removed. This
checks generic behavior and the deployed counter, but does not qualify coordinated
requests from multiple source addresses. A separate test submitted the same valid reset
token twice concurrently with two candidate passwords. Exactly one request succeeded;
only that request's password authenticated afterward. This verifies single-use behavior
under concurrent consumption, but does not qualify coordinated requests from multiple
source addresses or all session-security criteria in
[Participant password reset](https://github.com/myota-platform/myota-next/issues/114).

### Phase 6 deployed Participant email-change UI checks — 2026-10-27

The signed-in Participant UI started a double-verification change in `myota-test`; the
test Mailpit sink received one message for the current address and one for the proposed
address. The participant cancelled the pending change, the original address remained
authoritative, and a follow-up mailbox query found no messages for the synthetic test
alias after cleanup. This verified the deployed request, dual-delivery, and cancellation
path.

An API qualification on the same deployment then confirmed the cancellation and
concurrent-completion edges with a uniquely named synthetic participant. After verifying
only the proposed address, cancellation retained the old address as authoritative, the
other confirmation token was rejected, and sign-in with the proposed address failed.
For a separate pending change, the old- and new-address tokens were submitted at the same
time: both requests completed successfully, exactly one reported the state transition,
and the new address became authoritative. Sign-in with the new address succeeded and the
old address no longer authenticated. The test Mailpit messages generated by this run
were deleted by exact message IDs; unrelated messages were retained. This records the
deployed race outcome.

Additional `myota-test` browser and API checks then exercised actual confirmation links
from the test Mailpit sink. The Participant opened the current-address link first; the
new address still could not sign in and the old address remained authoritative. Opening
the new-address link then completed the change, after which only the new address could
sign in. Reopening either link showed the invalid/already-used state, and completion
notices reached both addresses. A separate pending operation was shortened to expire
after ten seconds in Core; after expiry, the actual new-address link showed the
invalid/expired state and the old address remained authoritative. A token from a
cancelled operation was also submitted while a different change was pending: Identity
rejected it, left the current account and pending operation unchanged, and accepted the
new operation's own two confirmations. These tests used separate synthetic participants;
their account rows and all generated Mailpit messages were removed and verified absent.

On 2026-10-27, the deployed email-change API flow was exercised across a temporary
SMTP outage. The test-only Mailpit sink was scaled to zero before requesting the change.
Identity accepted the request, both addresses remained unverified, and the old address
remained authoritative. The Email worker recorded two retryable failures for the
current-address verification message; after the sink was restored, that message was
delivered on attempt three. The proposed-address verification message was delivered on
its first attempt. The participant confirmed the current address first and remained on
the old address; the proposed address could not sign in until its own link was confirmed.
After both confirmations, the new address became authoritative, the old address could
no longer sign in, and completion notices reached both addresses.

The synthetic account, its Core delivery/outbox/security rows, Activity notifications,
and all Mailpit messages were removed after the run. The SMTP sink returned to 1/1 and
all chart-owned `myota-test` Deployments were ready. This qualifies recovery from a
transient SMTP connection outage in the deployed Identity-to-Email path; it does not
replace the separate retry-exhaustion and audited-redrive evidence in
[SMTP operations](../operations/single-instance-restart-recovery.md). The deployed
browser path covers successful double confirmation, partial state, expiry, and replay;
the API path also covers cancellation, mismatched-operation tokens, and concurrent
confirmation. Address-conflict behavior is recorded in issue #115. See
[Participant email change](https://github.com/myota-platform/myota-next/issues/115).

It then adds a callsign, submits verification evidence, and verifies the callsign
through the live Identity API. The same browser workflow exports the resulting account
and checks that its security events retain role-replacement and account-update order.
Callsign evidence remains in the separate evidence list; callsign lifecycle facts are
outbox events, not account security events. This complements the service fixture's
snapshot, access-control, and exact-integer export checks with persisted database
behavior.

The live browser path also exercises the full callsign lifecycle: adding and verifying a
callsign with evidence, selecting and replacing the primary, and retiring the old
primary; the test checks the persisted account and callsign state and lifecycle outbox
events. Login, refresh, recovery request/reset, and OIDC mapping use the reference's
Python-truthy required-field checks before authentication or persistence, with the same
`missing required fields` response precedence.

The Python retired-permission fixtures are also covered in Nest: persisted custom-role
definitions omit `operations.read`, and current-account scopes are recalculated from
live role assignments instead of retaining that retired scope from an access token.
Profile-image uploads accept JPEG, PNG, or WebP up to 5 MiB, reject animation and
dimensions above 4096 pixels, honor EXIF orientation, center-crop to 512 by 512, remove
source metadata, and try WebP qualities 85, 75, 65, and 55 under a 256 KiB output cap in
both the Pillow and Sharp paths.

The raw Identity upload route streams past the JSON parser into bounded image
normalization. Required body and 5 MiB size checks happen before authentication; media
type and image decoding checks happen after authentication, matching Python's request
order. Both paths use centered Lanczos-3 resizing; Sharp selects the kernel explicitly
and ignores embedded ICC profiles to match Pillow's direct channel conversion. A
transparent gradient fixture generated with the pinned Python profile-image normalizer
(Pillow 12.3.0) is checked against the Nest output after WebP decoding: mean visible RGB
difference is 1.20/255, the 99th percentile is 5/255, mean alpha difference is
0.013/255, and maximum alpha difference is 2/255.

The encoded WebP files are not byte-identical (10,050 bytes from Sharp and 9,994 from
Pillow); the compatibility test therefore guards decoded image appearance and size
limits. A separate Pillow 12.3.0 EXIF-orientation fixture checks the oriented crop and
source-metadata removal. Sharp explicitly matches Pillow's shared WebP quality, alpha
quality, effort, lossless, preset, and transparent-pixel options. Administrative
profile-image, account-detail, and account-export reads authorize the caller before
resolving the target account, matching the Python handler's error precedence.

An authorized malformed or absent target ID returns 404 with the quoted ID detail
produced by Python's `KeyError`, including its escaping of quotes, control characters,
and non-printing Unicode. Account-role reads also authorize first; because the Python
handler filters assignments without resolving an account, an authorized malformed or
absent target returns an empty role list. An existing account without a readable profile
image returns the quoted `KeyError` detail `'profile image not found'`.

Sharp inspects all WebP frames and reads APNG animation-control chunks before applying
the reference's animation rejection rule, including APNG files with a separate default
image. A Pillow-generated APNG fixture with one animation frame and a separate default
image verifies rejection when Sharp reports no page count. A separate two-frame WebP
fixture verifies that Sharp's page count rejects animated WebP as Pillow does.

Pixel decoding remains limited to one frame and 4096 pixels per dimension. Profile-image
and account update timestamps are assigned independently, matching the reference's two
clock reads. The current-account and login/refresh account projections include account
creation time, primary callsign ID, and callsigns as separate fields, matching the
Python account projection. Account creation assigns `createdAt` and `updatedAt`
independently, and an initial callsign advances the account's `updatedAt`, matching the
reference's separate clock reads.

Account creation preserves a truthy callsign's submitted type until normalization, so
non-string values fail instead of being accepted through JavaScript string coercion.
Initial callsigns trim only surrounding Python whitespace before uppercasing; internal
whitespace is preserved as by the reference. Direct callsign creation also reads
`verifiedAt`, `createdAt`, and `updatedAt` independently and advances the account update
time afterward.

Primary selection and retirement advance the account update time separately; retirement
preserves an explicitly supplied `validTo` value in its response. Callsign verification
assigns independent verification, update, and per-evidence review times; evidence ID
arrays use the durable insertion-order value. Password recovery refreshes the revocation
time on every session row for the account, including sessions already revoked, matching
the Python handler.

Login audit events preserve the reference's `actorId` payload and account aggregate for
known accounts, while unknown-account events remain associated with the `system`
aggregate. Failed login attempts for known accounts without a password credential now
create lockout state in Core and trigger the same five-attempt, fifteen-minute lockout
as other known accounts. The credential row can hold this state with a null password
hash and password-change timestamp; password setup fills those fields and clears the
lockout state.

Global operators bypass the general attempt throttle but still enter this
password-failure lockout after five bad passwords, matching the Python login handler.
NestJS login also verifies a fixed-salt `hashlib.scrypt` credential generated by the
Python reference, confirming the shared password-derivation parameters and unpadded
base64url encoding. This is behavioral compatibility evidence; the new platform starts
with empty databases and does not import old accounts.

The internal email-recipient resolver rejects revoked service tokens before scope checks
and maps malformed UUID forms to the same unavailable-recipient response as the Python
handler, including its quoted `KeyError` detail. Service-token issuance keeps the email
client-credentials flow on its fixed `identity.email.resolve` scope and `myota-identity`
audience with a five-minute expiry. Other service tokens require
`identity.service.issue` and cannot claim the reserved email-recipient scope.

Issuance audit events contain the service and granted scopes, never the client secret.
The Gateway integration now issues the email service token, resolves a live bootstrap
recipient directly through Identity's internal endpoint, verifies reserved-scope denial
for other service tokens, and confirms logout revocation prevents subsequent resolution.
Identity startup now idempotently provisions the configured bootstrap account, sets its
password only when no credential exists, ensures its global operator role, and writes
the corresponding Core outbox and security events.

The Admin Identity UI creates or edits one account at a time. One account update can
replace several role assignments in a single synchronous Core transaction, and account
creation can include its initial callsign and role set in that transaction. Programme
management likewise works on one selected programme, content item, or policy draft at a
time; category assignment, content review/publication, and policy transitions complete
synchronously. These areas expose no long-running import or multi-account batch command.
Identity email requests are durably handed to the separate Email worker, whose delivery
and retry qualification is tracked in [issue #13](https://github.com/myota-platform/myota-next/issues/13).

Administrator account search now uses full default Unicode 15.0 case folding, matching
the Python 3.12 reference. A read-only repeatable-read Core query filters names and
email addresses and returns only the requested account IDs in reference insertion order,
while computing the exact matching total. The service then loads profile, role, and
callsign details only for that page. The Admin Identity view follows the returned page
metadata and lets administrators move between matching account pages without loading the
full account list.

Its security-event feed pages through the API's audit history in 20-event increments,
using the Core `event_order` sequence to order events with tied timestamps. Login,
recovery, account creation, and account updates also use Unicode case-folded Core email
keys with a unique index; the forward migration checks legacy JSONB emails for case-fold
collisions before cutover. OIDC provider registration remains create-only, matching the
pinned Python handler; repeated requests create separate mappings even when they carry
the same optional `Idempotency-Key`.

Mapping field values are stored verbatim; non-empty whitespace-only strings and explicit
`null` values for optional `scopes` and `enabled` fields are preserved as by the
reference. Its runtime response is `201` even though the preserved upstream OpenAPI
contract declares `200`. Creation and update timestamps are separate reads, and the
audit event retains the reference payload without adding an actor field. The Gateway API
integration check now verifies default scopes and enabled state, repeated-key
create-only behavior, and verbatim whitespace and explicit-null persistence.

Programme RULES policy publication uses `schema.rules` when the key is present,
including explicit `null`; it falls back to the full schema only when the key is
omitted, matching Python's `dict.get` behavior. Programme and entity-type creation, plus
Programme-content and policy-draft creation, submission, review, and publication, retain
independent timestamps for lifecycle events and `updatedAt`, matching the reference's
separate clock reads.

Their UTC timestamp strings retain six fractional digits from the Programme database
clock, including review history and event payloads. Programme creation retains its
required-field checks before admin authorization; Programme updates, entity-type writes,
and content workflows perform their request checks after the same authorization and
record-resolution steps as the reference handlers. Their services receive parsed request
objects without global DTO validation preempting that order.

Required programme and content fields use Python truthiness, so empty arrays and objects
remain falsey. Missing programme, policy-draft, and workflow content records preserve
the reference's quoted-ID 404 details when their handlers use direct dictionary lookups;
content and policy PATCH requests retain their distinct 400 missing record responses.
Programme list pages and shared-category `assignedProgrammes` arrays preserve the
reference's insertion order through a Core-owned record sequence; existing rows are
backfilled by creation timestamp and slug.

Shared entity-type catalogue items use Python code-point ordering by code. Programme
content lists sort by key and locale, preserving insertion order for versions with the
same pair; the Core migration backfills that order from creation timestamps and assigns
sequence values to new content. Entity-type `active` inputs and stored values are
coerced using Python truthiness rather than requiring a JSON boolean, including falsey
legacy JSON values, before the normalized catalogue record is persisted.

Entity-type string fields and geometry values use Python-style conversion of JSON
booleans, nulls, arrays, and objects while preserving float tokens such as `1.0`
separately from integer `1`; whitespace-only labels retain the `category label must not
be empty` response. Programme PATCH requests with `status: "ARCHIVED"` follow the
reference's archive action: other supplied update fields are ignored, the policy version
is unchanged, and the archive event contains only the slug.

An invalid PATCH `status` is rejected before admin authorization and skips validation of
other supplied fields, matching the Python handler's response order. Programme-content
PATCH with an unrecognized truthy status falls back to a content edit after loading the
record, matching the Python handler's action dispatch and error order. Truthy status
values dispatch before general field validation; recognized workflow actions ignore
unrelated supplied fields, as the corresponding Python handlers do. Focused service
fixtures pin invalid programme-status precedence and verify that archive ignores extra
update fields while preserving the policy version and emitting only the slug in its
archive event.

Required review and publication fields use Python JSON truthiness, including for array
and object values. Direct content review and publication also authorize before
required-field and action validation, then resolve the content record, matching the
Python handlers.

`programme-content.compatibility.spec.ts` also pins save-content validation order:
after authorization, a cross-programme content ID is rejected before missing fields,
while an existing same-programme record checks required fields before its lifecycle
status. This matches the Python `save_content` sequence and avoids changing which error
an Admin sees for a conflicting record.
