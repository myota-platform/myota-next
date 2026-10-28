# Implementation status

This repository is a clean Node.js and NestJS implementation of MyOTA, based
on the pinned [`myota` reference](https://github.com/myota-platform/myota/tree/7f904a5130e59006765cf882956a4adbfecb17ec).
The [parity matrix](parity-matrix.md) is the acceptance inventory; this page
summarizes implementation coverage and remaining gates.

## Canonical implementation repository

`myota-platform/myota-next` is the canonical repository for ongoing
implementation of the new platform. New implementation work belongs here.
The existing [`myota` monorepo](https://github.com/myota-platform/myota) is
retained as the pinned behavioral reference; this source-of-code decision does
not move live deployment ownership or claim production cutover.

## In place

- Node.js 24, NestJS 12, and `@nestjs/observe` across the independently
  startable API and worker applications.
- Exactly three application databases: Core for Identity, Programmes, and
  Email; Activity; and Geodata with PostGIS. Services own their schemas and do
  not join across databases.
- API and worker implementations for Identity, Programmes, Activity, Geodata,
  and Email, including the documented durable work, outbox, retry, lease, and
  redrive flows.
- Separate Admin and Participant applications, with browser coverage for key
  account, programme, Geodata, Activity, and award workflows.
- Workspace build, static checks, container images, local Compose, and Helm
  deployment definitions.

The primary user workflows across all five product areas are implemented and
checked against the accelerated criteria in
[`parity/completion-criteria.md`](parity/completion-criteria.md). The remaining
items below are additional edge-case and production qualification, not missing
primary product areas.

## Remaining gates

- **Additional compatibility qualification:** broader payload combinations,
  obscure validation ordering, and rare failure outcomes remain available for
  follow-up. The accelerated completion criteria require the primary workflow,
  authorization, persistence, and shared validation/conflict checks; route
  presence alone is not proof.
- **Recovery:** single-server JetStream restart, three-node JetStream leader
  failover for Activity workers and notifications, each of the three owner outboxes, and
  all four Geodata worker durables; selected worker lease recovery, redrive, Geodata
  multipart object-store recovery, and a three-owner backup and restore rehearsal have
  evidence. A PostgreSQL TCP fault proxy now qualifies Geodata import claim, state lookup,
  retry-state persistence, and retention cleanup after source-object deletion.

Activity retry settlement, terminal work dead-letter persistence, ADIF retention, and
notification dead-letter persistence also have fault-proxy evidence. Notification
terminal settlement now also has three-node JetStream leader-failover coverage. Failover
for other consumers, PostgreSQL clusters, and additional worker and object-store
recovery paths remain open. See [worker and operations
coverage](parity/workers-operations.md), the [database backup and restore
notes](operations/database-backup-restore.md), and the [object-store recovery
notes](operations/object-store-recovery.md).

- **Web applications:** CI exercises Admin sign-in/dashboard, Identity account
  creation and callsign management, plus live Admin UI export and
  deactivation/anonymization with persisted-state and lifecycle-event checks, custom
  Identity role creation and updates with persisted permission and audit checks,
  scoped-role-preserving account edits with duplicate-email conflict handling, Admin
  password resets that revoke existing sessions, and status-only account deactivation
  while an existing owner refresh session remains rotatable, Activity correction review,
  and policy publication against running NestJS services through the Gateway.

Admin content creation, review, and publication now also run through the live Admin,
Gateway, and Core services, with the public programme-content response checked
afterward. Participant profile editing and owner callsign creation, cropped
profile-image upload and deletion, evidence submission, primary selection, and
retirement also run against live Identity APIs. Participant activation creation, QSO
recording, and closing run through live Activity APIs.

Participants can also upload ADIF logs to open activations and follow import status; CI
checks the displayed result, imported QSO, and completion notification across
Participant, Gateway, and Activity workers. Admin award publication and issuance, plus
Participant eligible-level requests, now cross live Identity and Activity APIs and
verify persisted request facts and issuance records. Public catalogue loading uses live
services as well.

Participant registration with email verification and delegated Participant account
management are implemented, including the `PARTICIPANT_ADMIN` role, Identity API
authorization, Admin account workflow, and Participant registration/resend/verification
UI. `myota-test` qualification includes authenticated reset-request and invalid-link
browser checks, a complete valid reset-link journey, and deployed expired-link and
request-throttle checks. The expired link returned HTTP 400 without changing the synthetic
account password; six requests to a nonexistent address returned the same generic response
and reached the server-side limiter. Email-change initiation, dual delivery to the test
Mailpit sink, and cancellation with the original address retained are also verified.
Two concurrent submissions of one reset token changed the password exactly once, and
only the winning password authenticated.
Participant email change has deployed browser and API evidence for partial confirmation,
successful verification at both addresses, token replay rejection, expired-link handling,
and the resend flow. API checks show that a canceled operation's token cannot affect a
later pending change, simultaneous confirmations apply one transition, and both completion
notices are sent. The old address remained authoritative on expiry and after only one
confirmation; the new address became authoritative only after both confirmations. On
2026-10-28, both stale links from a superseded resend were rejected, and the two replacement
links completed the change in order while preserving the old address until the second
confirmation. The synthetic account was restored to its original address and login verified;
all generated messages were removed and Mailpit was empty. Email-change delivery recovery
after a temporary SMTP outage is also verified. Coordinated multi-source throttling and
deployed telemetry-secret checks remain open under #114. A revision 73 reset test rejected
two pre-reset access sessions and both refresh credentials; the temporary password worked
and the original password was restored. See [Identity and Programme parity](parity/identity-programmes.md)
and the [Phase 6 readiness record](operations/phase6-readiness.md).

Public Activity activation history, leaderboard, and JSON/CSV result exports are also
checked through the live Gateway. Participants can read their own request status, while
cross-account reads are denied. Admin can queue certificate PDF rendering, and
Participant exposes the download only after the artifact is ready. The latest render-job
status persists in Admin across page reloads. Admin GeoJSON, OSM GeoJSON, WFS GeoJSON,
ArcGIS FeatureServer JSON, KML, GPX, OSM PBF, Shapefile, and ParkServe US file uploads
now run through the resumable multipart API, the CI S3-compatible fixture, and the
Geodata preprocessing worker; CI verifies each completed upload, preprocessed import,
source object, and review candidate.

Candidate status review now runs live through Admin, Gateway, and Geodata, with
persisted version, reviewer, status history, audit, and outbox checks. Conflation review
also runs live through Admin and Gateway, verifying the selected survivor, reviewer,
resolution history, idempotency record, and outbox event in Geodata. The Admin
refresh-schedule page now creates a category-scoped schedule, uploads a complete
snapshot, and verifies worker completion through live services.

A separate Gateway check verifies the manifest, queued processing state, schedule
timestamps, and outbox events. Secondary browser presentation states may continue to use
intercepted API responses where they are read-only. All high-impact Admin mutations have
live browser evidence; Orca reviewed secondary Admin and Participant workflows, and all
registered Admin routes have Axe and narrow/wide viewport checks. Remaining read-only
dashboard/filter and monitoring presentation combinations are dispositioned in
[L-11/L-12](remaining-work-ledger.md#l-11--complete-browser-compatibility-coverage-for-admin-workflows)
and Phase 3 issues [#22](https://github.com/myota-platform/myota-next/issues/22) and
[#7](https://github.com/myota-platform/myota-next/issues/7). Primary workflow review
against the isolated deployment remains under Phase 6 issue #10.

- **Production operations:** qualify persistent database operations, NATS,
  object storage, secrets, observability, deployment, and release automation.
  Phase 6 has isolated SMTP STARTTLS retry/replay, fresh-install, backup/restore,
  and rollback evidence; the remaining readiness work is tracked by #10.
  Protected rollout [40645993158](https://github.com/myota-platform/myota-next/actions/runs/40645993158)
  deployed chart `1.1.6-testing.b6a158aeadad.1` at Helm revision 72. All 17
  Deployments (22 replicas) and 17 Prometheus targets are ready. The in-cluster
  receiver records authenticated Admin and Participant API telemetry across
  Gateway and Identity, including matching traces, forwarded logs, and HTTP
  200 metrics. At revision 72, Activity Notifications also emitted a structured
  settlement log for a processed login event. Its snapshot and forwarded log
  share the request trace ID with Gateway and Identity.

  All seven MyOTA Prometheus rules load with healthy evaluation. Two firing
  outbox dead-letter warnings carry `service_id=outbox-worker`; the test
  Alertmanager has no notification receiver. Hosted Observe delivery and
  external alert delivery remain unqualified. See
  [Observe delivery](operations/observe-delivery-smoke.md) and Phase 6 issues
  #90 and #91.

  A supplemental password-recovery run delivered two synthetic messages to
  Mailpit and showed two successful `password-reset.v1` Email worker attempts;
  the test password was restored and messages were deleted. Its revoked-session
  probes returned HTTP 403 while the local helper expects 401, so that assertion
  needs reconciliation before calling the session-revocation check clean. The
  earlier Participant email-change retry evidence is in the
  [Identity parity record](parity/identity-programmes.md) and issue #115.
  Authenticated Admin Grafana viewing is qualified under #116. Geodata's optional
  BigDataCloud Secret remains absent; provider-backed enrichment and catalogue
  backfill remain open under #110/#111. See the
  [location enrichment guide](operations/location-enrichment.md).

- **Geodata performance:** larger datasets and full worker throughput remain
  unqualified. `MYOTA_UPLOAD_WORKERS` caps multipart finalization per Geodata
  API process. `MYOTA_IMPORT_WORKERS` caps preprocessing and promotion together
  per worker process when native concurrency settings are absent. Replicas
  multiply these process-local limits; compare throughput and resource use
  before production tuning.

Normal Node CI keeps API and worker behavior, browser workflows, build, and
static checks on every push. Database backup/restore, outage and restart
recovery, and large-input RSS qualification run in the manually triggered
Operational and performance qualification workflow so these longer deployment
and performance checks do not delay functional parity work.

## References

- [Function parity matrix](parity-matrix.md) and its [detailed behavior pages](parity/): requirements, coverage, and known differences.
- [Implementation plan](implementation-plan.md): implementation sequence and exit gate.
- [API baseline](api-baseline.md) and [operation traceability](api-operation-traceability.md): contract operations and controller ownership.
- [Database backup and restore](operations/database-backup-restore.md) and [deployment guide](../deploy/README.md): operational procedures and deployment state.

This repository is a development baseline. Do not use it in production until
the parity and operational gates above are closed. The current goal starts from
empty databases and excludes transfer from the old platform.
