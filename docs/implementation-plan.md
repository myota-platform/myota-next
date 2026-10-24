# Remaining parity and implementation plan

## Objective and current state

Finish the behavior and operational gaps recorded in the [parity matrix](parity-matrix.md)
for the new Node.js/NestJS platform. Start with the user-facing behaviors that affect
correctness, authorization, and data integrity; then qualify recovery, capacity, and
deployment.

The primary workflows across Identity, Programmes, Activity, Geodata, Email, Admin, and
Participant are implemented. All 141 OpenAPI operations map to NestJS routes. That route
inventory is not behavioral parity evidence. The detailed parity pages and
[implementation status](status.md) identify the remaining work; most open items are
qualification or edge behavior rather than missing product areas. Add code only where
that evidence identifies a real behavior gap.

The new platform starts from empty databases. Migration of data from the former system is
out of scope. Preserve the three database owners and keep target-only API extensions
separate from upstream parity claims.

## Execution model: synchronous commands and asynchronous bulk work

Apply this rule to every product area and UI:

- Keep explicit, bounded user commands synchronous when they must validate and commit
  one atomic outcome. This includes commands that act on a selected set of records, such
  as status changes, edits, reviews, approvals, promotions, and other multi-item
  administration actions. Validate the full selection and either commit it or reject it
  in the owning service's database transaction. Return the final outcome in the request;
  do not turn these commands into jobs because they affect multiple records.
- Run large ingestion, imports, bulk data processing, and broad or historical
  recomputation asynchronously. Return a durable job identifier and expose progress,
  terminal status, and safe retry behavior. A UI may start and monitor this work, but
  must not present acceptance as completion.
- Keep bounded calculations required to finish one synchronous atomic command within
  that command. Run full, historical, rebuild, or otherwise long-running calculations
  as jobs. In Activity this means individual QSO writes/corrections and bounded award
  decisions stay synchronous, while log uploads and their QSO ingestion, plus broad
  award recalculation, are asynchronous.
- Publish transactional outbox events after the owning database commits. Request
  completion for a synchronous command must not depend on NATS delivery. Preserve
  service database ownership; this rule does not imply a cross-service transaction.

## Step 1: Establish the remaining-work ledger

- Review the [remaining-work ledger](remaining-work-ledger.md) against every outstanding or
  qualified-later item in the [parity pages](parity/) and [operations guides](operations/).
- For each item, record its owning service or application, the reference behavior, current
  implementation location, existing evidence, missing evidence, risk, and next check.
- Classify it as a product behavior gap, additional compatibility qualification,
  recovery/operations qualification, performance qualification, or optional extension.
- Remove duplicate items only after linking the same evidence to every affected area.
  Do not count a route mapping, unit test, or successful build as workflow parity.

**Exit:** Every remaining-status statement in the parity pages is represented in the
ledger or explicitly marked as an accepted limitation. Product gaps and operational
gates are distinguishable.

## Step 2: Close consequential product-behavior gaps

Work service by service, adding a focused reference comparison only where existing
fixtures do not cover an important outcome.

- **Identity and Programmes:** cover remaining authorization, idempotency, validation,
  conflict, and lifecycle outcomes that could change access or persisted state. Keep
  explicit bounded UI commands synchronous, including commands applied to a selected
  set; run large imports or bulk processing asynchronously with visible job status.
  Verify a successful SMTP delivery using the deployment trust roots before declaring
  email delivery qualified.
- **Activity:** complete broader compatibility checks for activation and QSO behavior,
  imports, corrections, public results, awards, notifications, and job status. Keep
  individual QSO writes and corrections synchronous. Process uploaded logs and their
  potentially large QSO ingestion asynchronously, with durable job status and safe retry;
  do not report upload acceptance as completed import. Keep bounded award decisions
  needed by one atomic command synchronous, and run broad, historical, rebuild, or
  otherwise long-running award calculations asynchronously. If Admin or Participant
  issues a bounded atomic command over several selected records, validate and commit or
  reject the set synchronously in the owning transaction. Prioritize ordering or failure
  behavior that could produce an incorrect write, duplicate side effect, leaked record,
  or misleading user outcome. Keep the Nest-only CSV ingestion endpoint documented as
  an extension; it is not evidence of reference parity.
- **Geodata:** keep bulk source intake, upload processing, parsing, validation, and
  preprocessing asynchronous. Make user-requested entity mutations synchronous, including
  status changes, edits, review decisions, and promotion or approval of selected
  candidates. A multi-entity Admin action must apply its requested set in one Geodata
  database transaction and return the completed result in the same request; it must not
  enqueue a promotion job or silently fall back to background processing. Validate the
  full selection before writing so the operation has all-or-nothing behavior. Preserve
  idempotency and concurrency checks. Transactional outbox events may publish after the
  mutation commits; the API result must not depend on broker delivery. Also complete
  fixtures for outstanding PBF inputs above the qualified size, less common OSM
  geometries, remaining geometry/CRS cases, and datum-grid-dependent transformations.
  Verify any confirmed differences against the pinned importer before changing behavior.
- **Email:** keep bulk delivery asynchronous and verify SMTP delivery, TLS, failure,
  retry, deduplication, and notification outcomes in the deployment environment, using
  the existing allowlisted templates and privacy constraints.

For each confirmed gap, implement the smallest compatible change, update its contract or
traceability only when the contract changes, and link the passing evidence from the owning
parity page. Do not expand APIs merely to make the target appear more complete.

**Exit:** Each material product behavior has code-level and workflow evidence; unresolved
differences are documented with their user or data impact and an explicit disposition.

## Step 3: Complete primary browser quality

- Review keyboard use, focus order, labels, contrast, and screen-reader announcements in
  the primary Admin and Participant journeys.
- Check responsive layouts at supported narrow and wide viewport sizes.
- Exercise permission denial, validation and conflict responses, unavailable services,
  failed uploads, interrupted uploads, and delayed or failed asynchronous work.
- Verify across Admin and Participant workflows that explicit bounded commands return
  their final outcome synchronously, including multi-item selections. Verify that large
  imports, log/QSO ingestion, and broad award calculations expose asynchronous job
  progress and terminal status; distinguish job acceptance from completion in the UI.
- Use live services for primary journeys. Use intercepted responses only for secondary
  presentation states that are not an end-to-end product workflow.
- Record findings by application and workflow; fix blockers before marking the browser
  area complete.

**Exit:** Primary workflows pass browser checks at supported viewport sizes, keyboard and
accessibility blockers are resolved, and important failure states give recoverable,
accurate feedback.

## Step 4: Qualify worker and infrastructure recovery

Run controlled fault injection first, then repeat the relevant scenarios against the
isolated deployment. Keep state in the owning database and acknowledge broker messages
only after durable state changes.

- **Activity workers:** qualify asynchronous log upload and QSO ingestion, broad award
  calculation, and other worker work kinds. Kill each during side-effecting processing;
  verify lease recovery, idempotency, and final records. Cover process loss after
  terminal dead-letter persistence but before broker settlement. Keep bounded QSO
  commands and award decisions that are part of synchronous atomic commands out of the
  worker-job path.
- **Activity notifications and Email:** qualify broker retry exhaustion and recovery under
  the configured deployment topology, including terminal dead-letter settlement.
- **Geodata workers:** cover process loss during claim and after side effects for the
  remaining asynchronous work kinds, including bulk import preprocessing. Remove the
  Admin-requested promotion/approval queue path as part of Step 2; those operations must
  finish transactionally in the API request and are qualified as synchronous mutations,
  not worker jobs. Extend object-store outage/recovery checks beyond multipart upload to
  the other consumers and persistent-volume failure cases.
- **NATS and PostgreSQL:** qualify recovery from process and connection interruptions
  for the currently configured single NATS/JetStream instance and each owner database,
  including relay, API, and worker reconnection and transaction outcomes. Repeatable
  infrastructure and legacy-runtime evidence is recorded in
  [single-instance restart recovery](operations/single-instance-restart-recovery.md);
  repeat the application-level checks after the NestJS monorepo images are deployed.
- **Object storage:** verify the deployed persistence and recovery procedures separately
  from database backups. Confirm interrupted writes and cleanup remain safe to retry.

HA PostgreSQL, clustered NATS/JetStream, and multi-instance scale-out are optional future
infrastructure improvements tracked by standalone low-priority
[myota-next#24](https://github.com/myota-platform/myota-next/issues/24). They are not
requirements or blockers for Phases 1–6 or Launch Readiness.

**Exit:** Each listed failure window has a repeatable check with evidence of durable state,
no duplicate side effect, eventual completion or safe dead-lettering, and observable
recovery. Open failures are documented rather than inferred from process restart tests.

## Step 5: Set and verify workload capacity and source limits

- Build representative import fixtures and workloads for GeoJSON, WFS, ArcGIS, KML, GPX,
  Shapefile, and OSM PBF, including configured maximum sizes and feature counts.
- Extend OSM PBF qualification beyond 250,000 features and include less common geometries
  before setting a production cap.
- Measure throughput, peak memory, database load, broker backlog, and recovery time under
  explicit CPU, memory, configured launch replica counts, and database-pool limits.
- Include representative log-upload/QSO-ingestion and broad award-calculation workloads;
  measure job latency, throughput, peak memory, database load, backlog, and recovery.
- Measure bounded synchronous commands in each owning area, including Activity QSO
  writes/corrections and award decisions where applicable, alongside Geodata
  single-entity and multi-entity mutations. Set documented request/selection limits from
  those measurements; reject an over-limit atomic selection clearly rather than
  converting it to asynchronous work or partially applying it.
- Measure synchronous single-entity and multi-entity status, edit, review, promotion, and
  approval transactions under representative selection sizes. Set a documented request
  limit from those measurements; reject an over-limit selection clearly rather than
  converting it to asynchronous work or partially applying it.
- Compare results with the pinned Python implementation where a like-for-like measure is
  possible; document differences in process-RSS scope and workload where it is not.
- Keep these capacity measurements on the configured launch replica counts. Horizontal
  multi-instance scaling is future work under myota-next#24, outside the launch gate.
- Qualify the importer’s live-source host allowlist, source licenses, source outages,
  schedule behavior, and safe retry before enabling it outside the isolated environment.
- Set worker concurrency, upload, feature, and timeout defaults from measured limits.

**Exit:** Supported formats and limits have correctness fixtures, resource measurements,
and documented operating bounds. Source selection and outage behavior are reviewed
before scheduled fetching is enabled.

## Step 6: Qualify a fresh isolated deployment

- Initialize Core, Activity, and Geodata from empty databases using the deployment
  migrations. Verify ownership, health/readiness, and backup/restore with the target
  PostgreSQL and object-storage configuration. Do not import the old platform's data.
- Supply Observe and other credentials through the deployment secret store. Verify each
  independently deployed Nest process has its stable `serviceId`, instrumentation hook,
  and disabled reporting when credentials are absent.
- Render and deploy the reviewed Helm configuration to the isolated `myota-test` release
  using immutable image digests. Keep testing and production image sources separate.
- Exercise primary Admin and Participant workflows against that release. Verify logs,
  metrics, traces, alerts, NATS and database recovery, object-store recovery, backup, and
  restore using the deployment configuration.
- Verify rollback to the previous digest and confirm that migrations and persisted work
  remain compatible with the rollback procedure.

**Exit:** Fresh installation, primary workflows, observability, recovery, backup/restore,
image provenance, and rollback all pass in the isolated Helm release. This completes
qualification for review; it does not authorize production cutover.

## Completion gate

Do not claim full parity until the parity pages link each required behavior to its
implementation and compatibility evidence. Do not consider production use until Steps 3
through 6 pass in the isolated deployment and all remaining differences have an explicit
disposition. Production rollout and data transfer require separate user direction.
