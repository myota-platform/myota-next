# Implementation status

This repository is a clean Node.js and NestJS implementation of MyOTA, based
on the pinned [`myota` reference](https://github.com/myota-platform/myota/tree/7f904a5130e59006765cf882956a4adbfecb17ec).
The [parity matrix](parity-matrix.md) is the acceptance inventory; this page
summarizes implementation coverage and remaining gates.

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

These items describe implementation coverage, not complete function parity or
production readiness.

## Remaining gates

- **Behavioral parity:** qualify request, authorization, persistence, failure,
  and workflow behavior for the required operations and events. The parity
  pages record current coverage and gaps; route presence alone is not proof.
- **Recovery:** single-server JetStream restart, three-node JetStream leader
  failover for Activity workers and notifications, each of the three owner
  outboxes, and all four Geodata worker durables; selected worker lease
  recovery, redrive, Geodata multipart object-store recovery, and a three-owner
  backup and restore rehearsal have evidence. A
  PostgreSQL TCP fault proxy now qualifies
  Geodata import claim, state lookup, retry-state persistence, and retention
  cleanup after source-object deletion. Activity retry settlement, terminal
  work dead-letter persistence, ADIF retention, and notification dead-letter
  persistence also have fault-proxy evidence. Notification terminal settlement
  now also has three-node JetStream leader-failover coverage. Failover for
  other consumers, PostgreSQL clusters, and additional worker and object-store
  recovery paths remain open. See
  [worker and operations coverage](parity/workers-operations.md), the
  [database backup and restore notes](operations/database-backup-restore.md),
  and the [object-store recovery notes](operations/object-store-recovery.md).
- **Web applications:** CI exercises Admin sign-in/dashboard, Identity account
  creation and callsign management, plus live Admin UI export and
  deactivation/anonymization with persisted-state and lifecycle-event checks,
  custom Identity role creation and updates with persisted permission and audit
  checks,
  scoped-role-preserving account edits with duplicate-email conflict handling,
  Admin password resets that revoke existing sessions, and status-only account
  deactivation while an existing owner refresh session remains rotatable,
  Activity correction review, and policy publication against running NestJS
  services through the Gateway. Admin content creation, review, and publication
  now also run through the live Admin, Gateway, and Core services, with the
  public programme-content response checked afterward. Participant profile
  editing and owner callsign
  creation,
  cropped profile-image upload and deletion, evidence submission, primary
  selection, and retirement also run against live Identity APIs. Participant
  activation creation, QSO recording, and closing
  run through live Activity APIs. Participants can also upload ADIF logs to
  open activations and follow import status; CI checks the displayed result,
  imported QSO, and completion notification across Participant, Gateway, and
  Activity workers. Admin award publication and issuance, plus
  Participant eligible-level requests, now cross live Identity and Activity
  APIs and verify persisted request facts and issuance records. Public catalogue
  loading uses live services as well. Public Activity activation history,
  leaderboard, and JSON/CSV result exports are also checked through the live
  Gateway. Participants can read their own request
  status, while cross-account reads are denied. Admin can queue certificate PDF
  rendering, and Participant exposes the download only after the artifact is
  ready. The latest render-job status persists in Admin across page reloads.
  Admin GeoJSON, OSM GeoJSON, WFS GeoJSON, ArcGIS FeatureServer JSON, KML, GPX, OSM PBF, Shapefile, and ParkServe US file uploads now run through the resumable
  multipart API, the CI S3-compatible fixture, and the Geodata preprocessing
  worker; CI verifies each completed upload, preprocessed import, source
  object, and review candidate.
  Candidate status review now runs live through Admin, Gateway, and Geodata,
  with persisted version, reviewer, status history, audit, and outbox checks.
  Conflation review also runs live through Admin and Gateway, verifying the
  selected survivor, reviewer, resolution history, idempotency record, and
  outbox event in Geodata. The Admin refresh-schedule page now creates a
  category-scoped schedule, uploads a complete snapshot, and verifies worker
  completion through live services. A separate Gateway check verifies the
  manifest, queued processing state, schedule timestamps, and outbox events.
  Most other browser workflows still use intercepted API responses;
  broader payload coverage, accessibility, responsive behavior, and failure
  states remain to be qualified.
- **Production operations:** qualify persistent database operations, NATS,
  object storage, secrets, observability, deployment, and release automation.
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
