# Identity and Programmes

## Shared implementation notes

Gateway JSON forwarding and Identity outbox, security-event, evidence, and
idempotency JSONB writes preserve arbitrary-precision integer tokens from the
request parser through serialization, matching Python JSON handling.
Security-event feeds, account exports, and idempotency replays parse stored
JSONB text directly, preserving those integers on read as well.
Programme's Core database pool installs an exact integer JSONB parser for
programme records, entity types, policy drafts, content, and idempotency reads.

Focused Nest email-worker tests now cover the Python worker's allowlisted
participant and administrator commands, rejection of sensitive extra fields
and BOM-prefixed JSON, HTML escaping, and delivery-state persistence before the
JetStream acknowledgement. Duplicate acknowledgement, delayed retry, retry
exhaustion, and redacted SMTP error logging are also covered. The tests also
cover cached Identity token use, transient Identity failure, unavailable
recipients, and SMTP configuration validation. SMTP/TLS handshake behavior
is exercised against a local SMTP server: the client requests STARTTLS, begins
the TLS handshake, and sends no AUTH command when that handshake fails. A
successful SMTP delivery against deployment trust roots remains an operational
qualification gate. Identity recipient token expiry uses a monotonic clock
measured from before token acquisition, matching the reference cache timing.

Programme policy service coverage now exercises a rules draft through save,
submit, approval, and publication, including offset timestamp normalization,
review history, rules replacement, policy version increment, and the publication
fact. Policy body validation follows the reference's authorization order, while
an unknown-status PATCH resolves the draft before checking authorization; HTTP
fixtures pin both sequences. The Python reference separately pins the UTC
conversion behavior. Content publication converts `effectiveFrom` with Python
`str()` semantics before timestamp parsing, including floating-point JSON
tokens.

The email worker accepts the schema's trailing uppercase `Z` timestamp with
either `T` or `t` as the date/time separator, matching Python's RFC3339
validation. It preserves a leading UTF-8 BOM for `JSON.parse` to reject,
matching Python's `json.loads` behavior. HTML templates use Python's apostrophe
entity (`&#x27;`) when escaping user-provided names.

## Identity

Identity currently implements disabled public registration, password login,
refresh rotation, logout revocation, recovery request/reset, current-account
reads, owner-only profile updates, account creation, and administrator account
listing, owner/global account reads and account role reads in NestJS. The role catalogue endpoint returns built-in and persisted
custom roles under the existing authorized scopes; custom role creation and
partial updates are backed by Core transactions and security/outbox events.
Role definitions sort by code point, matching Python's string ordering for
custom codes containing underscores.
Role-definition POST and PATCH authenticate before DTO validation; PATCH also
resolves and rejects built-in definitions before validating the submitted
fields, matching the Python handler's response precedence. Role creation checks
truthy `code` and `name` values before applying Python `str()` conversion;
create and update preserve JSON float tokens such as `1.0` in those fields.
Falsey custom-role descriptions normalize to the empty string on create and
when explicitly supplied on update, matching the relational persistence path.
Empty or duplicate normalized role codes return the reference's 400 response.
An authorized PATCH for a missing custom role returns the reference's quoted
role-code 404 detail.
Owner profile updates authenticate and check revocation and account availability
before validating submitted fields, matching the Python handler's response
precedence. Website URL normalization also removes empty trailing query and
fragment delimiters, matching Python's `urlunsplit` behavior, and rejects
URLs without a syntactic authority, matching `urlsplit` validation. Non-control
internal URL whitespace retains the reference's URL-specific error detail,
while control characters and overlong values use its invalid-or-too-long detail.
Role arrays preserve assignment order, including multi-role replacements that
share a creation timestamp.
Role replacement also shares one timestamp between expiring prior assignments
and creating their replacements, matching the Python handler.
Administrative account PATCH and role-assignment PUT authorize before resolving
the target ID; malformed or absent targets return the quoted-ID 404 from the
Python dictionary lookup before request-body validation. These routes preserve
profile, password, status,
anonymization, and role replacement behavior in Core transactions. As in the
reference handler, changing status alone does not anonymize the account or
revoke its sessions; existing refresh sessions also remain rotatable, and both
session revocation and anonymization happen when `anonymize` is true. Password
changes and anonymization refresh `revokedAt` on already-revoked sessions as
well, matching the handler's per-session update. Callsign
creation, evidence, verification, primary selection, and retirement also write
to the relational Core model and outbox. Account reads and exports preserve the
reference's callsign, evidence, and security-event insertion order through
Core-owned order values. Existing rows are backfilled chronologically with IDs
as deterministic tie-breakers.
Callsign retirement authenticates and resolves the account and callsign before
validating optional fields. It checks a primary replacement before reading
evidence only when retiring the primary callsign; malformed replacement values
are ignored when the target is not primary, matching the reference's branch
behavior.
Callsign create, primary-selection, evidence, verification, and retirement defer
account-ID resolution until after their respective authorization checks; a
missing account returns the quoted-ID 404 before replaying an idempotent result
or resolving a callsign.
Callsign verification authenticates and resolves its target, then requires
evidence before validating the optional verification source, matching the
reference's error precedence.
Callsign creation, primary selection, and evidence submission check required
fields with Python truthiness before authorization, preserving the reference's
`missing required fields` response and precedence.
Primary callsign selection rejects malformed IDs with the same
`callsignId is not an active callsign on this account` response as a
non-matching ID instead of exposing a PostgreSQL UUID-cast failure.
Administrator account PATCH and role-assignment PUT authenticate and resolve
the target account before validating the request body, matching the reference's
response precedence. Account-update fixtures pin admin permission denial
before account lookup and missing-account responses before body validation.
Account PATCH validates profile fields and checks email
conflicts before validating status and participation type, matching the
reference's field order. When role replacement is requested, Nest checks
`identity.roles.assign` at the replacement step, after Core-backed account and
email-conflict handling; the encompassing Core transaction rolls back earlier
writes if role authorization fails. The PUT retains its roles-only request
shape while deferring DTO validation to that authorized sequence.
Focused Identity fixtures verify profile-image normalization against Pillow,
pin service-token signing to a Python-generated HS256 token (including Bearer
and expiry rejection), exercise callsign normalization, retired-value reuse,
duplicate rejection, and first-primary selection, and pin account-creation
permission and validation precedence plus Identity-administrator role
escalation denial to the Python handler. Recovery fixtures cover account
enumeration behavior, one-time token use, password length, and session
revocation. Login tests verify the eight-attempt general limit and the
global-operator bypass. Account, callsign, recovery, and authorization sequence
behavior still require broader automated compatibility coverage.
Login, refresh, recovery request/reset, and OIDC mapping use the reference's
Python-truthy required-field checks before authentication or persistence, with
the same `missing required fields` response precedence.
The Python retired-permission fixtures are also covered in Nest: persisted
custom-role definitions omit `operations.read`, and current-account scopes are
recalculated from live role assignments instead of retaining that retired
scope from an access token.
Profile-image uploads accept JPEG, PNG, or WebP up to 5 MiB, reject animation
and dimensions above 4096 pixels, honor EXIF orientation, center-crop to 512 by
512, remove source metadata, and try WebP qualities 85, 75, 65, and 55 under a
256 KiB output cap in both the Pillow and Sharp paths. The raw Identity upload
route streams past the JSON parser into bounded image normalization. Required
body and 5 MiB size checks happen before authentication; media type and image
decoding checks happen after authentication, matching Python's request order.
Both paths use centered
Lanczos-3 resizing; Sharp selects the kernel explicitly and ignores embedded
ICC profiles to match Pillow's direct channel conversion. A transparent
gradient fixture generated with the pinned Python profile-image normalizer
(Pillow 12.3.0) is checked against the Nest output after WebP decoding: mean
visible RGB difference is 1.20/255, the 99th percentile is 5/255, mean alpha
difference is 0.013/255, and maximum alpha difference is 2/255. The encoded
WebP files are not byte-identical (10,050 bytes from Sharp and 9,994 from
Pillow); the compatibility test therefore guards decoded image appearance and
size limits. A separate Pillow 12.3.0 EXIF-orientation fixture checks the
oriented crop and source-metadata removal. Sharp explicitly matches Pillow's
shared WebP quality, alpha quality, effort, lossless, preset, and
transparent-pixel options.
Administrative profile-image, account-detail, and account-export reads
authorize the caller before resolving the target account, matching the Python
handler's error precedence. An authorized malformed or absent target ID returns
404 with the quoted ID detail produced by Python's `KeyError`, including its
escaping of quotes, control characters, and non-printing Unicode. Account-role
reads also authorize first; because the Python handler filters assignments
without resolving an account, an authorized malformed or absent target returns
an empty role list. An existing account without a readable profile image
returns the quoted `KeyError` detail `'profile image not found'`.
Sharp inspects all WebP frames and reads APNG animation-control chunks before
applying the reference's animation rejection rule, including APNG files with a
separate default image. A Pillow-generated APNG fixture with one animation
frame and a separate default image verifies rejection when Sharp reports no
page count. A separate two-frame WebP fixture verifies that Sharp's page count
rejects animated WebP as Pillow does. Pixel decoding remains limited to one
frame and 4096 pixels per dimension.
Profile-image and account update timestamps are assigned independently,
matching the reference's two clock reads.
The current-account and login/refresh account projections include account
creation time, primary callsign ID, and callsigns as separate fields, matching
the Python account projection.
Account creation assigns `createdAt` and `updatedAt` independently, and an
initial callsign advances the account's `updatedAt`, matching the reference's
separate clock reads.
Account creation preserves a truthy callsign's submitted type until
normalization, so non-string values fail instead of being accepted through
JavaScript string coercion.
Initial callsigns trim only surrounding Python whitespace before uppercasing;
internal whitespace is preserved as by the reference.
Direct callsign creation also reads `verifiedAt`, `createdAt`, and `updatedAt`
independently and advances the account update time afterward.
Primary selection and retirement advance the account update time separately;
retirement preserves an explicitly supplied `validTo` value in its response.
Callsign verification assigns independent verification, update, and per-evidence
review times; evidence ID arrays use the durable insertion-order value.
Password recovery refreshes the revocation time on every session row for the
account, including sessions already revoked, matching the Python handler.
Login audit events preserve the reference's `actorId` payload and account
aggregate for known accounts, while unknown-account events remain associated
with the `system` aggregate.
Failed login attempts for known accounts without a password credential now
create lockout state in Core and trigger the same five-attempt, fifteen-minute
lockout as other known accounts. The credential row can hold this state with a
null password hash and password-change timestamp; password setup fills those
fields and clears the lockout state. Global operators bypass the general
attempt throttle but still enter this password-failure lockout after five bad
passwords, matching the Python login handler.
NestJS login also verifies a fixed-salt `hashlib.scrypt` credential generated
by the Python reference, confirming the shared password-derivation parameters
and unpadded base64url encoding. This is behavioral compatibility evidence;
the new platform starts with empty databases and does not import old accounts.
The internal email-recipient resolver rejects revoked service tokens before
scope checks and maps malformed UUID forms to the same unavailable-recipient
response as the Python handler, including its quoted `KeyError` detail.
Service-token issuance keeps the email client-credentials flow on its fixed
`identity.email.resolve` scope and `myota-identity` audience with a five-minute
expiry. Other service tokens require `identity.service.issue` and cannot claim
the reserved email-recipient scope. Issuance audit events contain the service
and granted scopes, never the client secret.
Identity startup now idempotently provisions the configured bootstrap account,
sets its password only when no credential exists, ensures its global operator
role, and writes the corresponding Core outbox and security events.
Administrator account search now uses full default Unicode 15.0 case folding,
matching the Python 3.12 reference. A read-only repeatable-read Core query
filters names and email addresses and returns only the requested account IDs
in reference insertion order, while computing the exact matching total. The
service then loads profile, role, and callsign details only for that page. The
Admin Identity view follows the returned page metadata and
lets administrators move between matching account pages without loading the
full account list. Its security-event feed pages through the API's audit
history in 20-event increments, using the Core `event_order` sequence to order
events with tied timestamps. Login, recovery, account creation, and account
updates also use Unicode case-folded Core email keys with a unique index; the
forward migration checks legacy JSONB emails for case-fold collisions before
cutover.
OIDC provider registration remains create-only, matching the pinned Python
handler; repeated requests create separate mappings even when they carry the
same optional `Idempotency-Key`. Mapping field values are stored verbatim;
non-empty whitespace-only strings and explicit `null` values for optional
`scopes` and `enabled` fields are preserved as by the reference. Its runtime
response is `201` even though the preserved upstream OpenAPI contract declares
`200`. Creation and update timestamps are separate reads, and the audit event
retains the reference payload without adding an actor field.

Programme RULES policy publication uses `schema.rules` when the key is present,
including explicit `null`; it falls back to the full schema only when the key
is omitted, matching Python's `dict.get` behavior.
Programme and entity-type creation, plus Programme-content and policy-draft
creation, submission, review, and publication, retain independent timestamps
for lifecycle events and `updatedAt`, matching the reference's separate clock
reads.
Programme creation retains its required-field checks before admin authorization;
Programme updates, entity-type writes, and content workflows perform their
request checks after the same authorization and record-resolution steps as the
reference handlers. Their services receive parsed request objects without
global DTO validation preempting that order. Required programme and content
fields use Python truthiness, so empty arrays and objects remain falsey.
Missing programme, policy-draft, and workflow content records preserve the
reference's quoted-ID 404 details when their handlers use direct dictionary
lookups; content and policy PATCH requests retain their distinct 400 missing
record responses.
Programme list pages and shared-category `assignedProgrammes` arrays preserve
the reference's insertion order through a Core-owned record sequence; existing
rows are backfilled by creation timestamp and slug. Shared entity-type catalogue
items use Python code-point ordering by code.
Programme content lists sort by key and locale, preserving insertion order for
versions with the same pair; the Core migration backfills that order from
creation timestamps and assigns sequence values to new content.
Entity-type `active` inputs and stored values are coerced using Python
truthiness rather than requiring a JSON boolean, including falsey legacy JSON
values, before the normalized catalogue record is persisted.
Entity-type string fields and geometry values use Python-style conversion of
JSON booleans, nulls, arrays, and objects while preserving float tokens such as
`1.0` separately from integer `1`; whitespace-only labels retain the
`category label must not be empty` response.
Programme PATCH requests with `status: "ARCHIVED"` follow the reference's
archive action: other supplied update fields are ignored, the policy version
is unchanged, and the archive event contains only the slug.
An invalid PATCH `status` is rejected before admin authorization and skips
validation of other supplied fields, matching the Python handler's response
order. Programme-content PATCH with an unrecognized truthy status falls back to
a content edit after loading the record, matching the Python handler's action
dispatch and error order. Truthy status values dispatch before general field
validation; recognized workflow actions ignore unrelated supplied fields, as
the corresponding Python handlers do. Required review and publication fields
use Python JSON truthiness, including for array and object values. Direct
content review and publication also authorize before required-field and action
validation, then resolve the content record, matching the Python handlers.
