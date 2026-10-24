# Remaining-work ledger

This ledger is the consolidated inventory of parity and operational items that
the current documentation marks open, outstanding, unqualified, or required
before production use. The initial inventory was reviewed against `main` at
`8c80da7`; implementation evidence and next checks are updated as the tracked
work proceeds. Recheck the source pages when this ledger is updated; their line
anchors are convenient starting points, not substitutes for reading the
surrounding evidence.

Each item names the owning area, work class, current implementation and
evidence, the missing evidence, user or operational risk, and the next check.
Repeated statements across parity and operations pages are consolidated under
one item and listed together in **Sources**. A source statement that is already
an accepted scope decision is recorded in the dispositions section.

## Open work

### L-02 — Verify real SMTP delivery with deployment trust roots

- **Owner:** Email worker and Identity integration
  (`apps/email-worker/`, `apps/identity/`).
- **Class:** Recovery and deployment qualification.
- **Reference behavior:** Allowlisted Identity and administrator email commands
  deliver over TLS, persist delivery state before acknowledgement, and apply
  the documented retry and deduplication behavior.
- **Current implementation and evidence:** Unit and local SMTP fixtures cover
  templates, escaping, state persistence, retry, deduplication, and failed
  STARTTLS behavior. These are summarized in
  [Identity and Programmes parity](parity/identity-programmes.md).
- **Missing evidence:** A successful delivery using the deployment's actual
  SMTP trust roots has not been qualified.
- **Risk:** Account setup and recovery messages may fail despite passing local
  tests, or use an untrusted TLS chain.
- **Next check:** Send an allowlisted message through the isolated deployment,
  verify TLS trust and the delivered message, then exercise configured failure
  and retry outcomes without exposing credentials.
- **Tracked by:** [Issue #13](https://github.com/myota-platform/myota-next/issues/13).
- **Sources:** [Identity and Programmes, lines 22–25](parity/identity-programmes.md#L22);
  [parity matrix, lines 48–52](parity-matrix.md#L48).

### L-04 — Qualify Activity worker process-loss windows

- **Owner:** Activity worker (`apps/activity-worker/` and
  `tools/run-activity-worker-recovery.mjs`).
- **Class:** Recovery/operations qualification.
- **Reference behavior:** Leases, durable job state, side effects, dead-letter
  persistence, and JetStream settlement remain safe when a process stops at
  every consequential point.
- **Current implementation and evidence:** Recovery checks kill workers after
  lease acquisition and before processing starts for all six work kinds.
  Process-loss checks now interrupt side effects for every kind: statistics
  snapshot writes, direct and broad award progress, QSO ingestion, ADIF QSO
  writes, and PDF artifact storage after the object is written but before its
  database transaction commits. They verify rollback of database effects,
  lease reclaim, successful retry, deterministic artifact overwrite, and a
  single render event. The checks also cover selected three-node leader
  changes. A child-process check persists a terminal failed job and dead-letter,
  kills the worker while its delivery is still pending, then verifies redelivery
  settles without reprocessing. Activity leader-failover checks retry ACK
  confirmation while extending the pending delivery. Isolated CI exercises Activity
  notification retry exhaustion and audited redrive, plus Email retry
  exhaustion followed by audited command replay; the Email dead-letter resolves
  only after delivery succeeds. The full checks, including ADIF side-effect
  interruption for all six work kinds, and ACK retry through JetStream leader
  change, passed in
  [operational qualification run 40093916289](https://github.com/myota-platform/myota-next/actions/runs/40093916289).
- **Missing evidence:** Retry exhaustion and operator redrive under the deployed
  topology, and recovery under the deployed topology, are still open. Terminal
  dead-letter persistence followed by process loss before settlement is covered
  by the existing CI check.
- **Risk:** A restart could duplicate or lose a QSO/award side effect, strand a
  job, or leave a terminal message unsettled.
- **Next check:** Exercise retry exhaustion and audited operator redrive in the
  isolated deployment when its recovery topology is available; verify terminal
  state, metrics, alerts, and operator recovery actions.
- **Tracked by:** [Issue #15](https://github.com/myota-platform/myota-next/issues/15).
- **Sources:** [Activity parity, lines 255–264](parity/activity.md#L255);
  [workers and operations, lines 35–57](parity/workers-operations.md#L35).

### L-05 — Qualify Activity notification retry exhaustion in deployment

- **Owner:** Activity notifications and Email (`apps/activity-notifications/`,
  `apps/email-worker/`).
- **Class:** Recovery/operations qualification.
- **Reference behavior:** Broker-side retry exhaustion, terminal persistence,
  acknowledgement, and redrive follow the configured deployment topology.
- **Current implementation and evidence:** CI covers PostgreSQL interruption,
  terminal dead-letter persistence, replica sharing, restart recovery, and a
  three-node JetStream leader change. Isolated CI also verifies Activity
  notification retry exhaustion and audited redrive, plus Email retry
  exhaustion followed by audited command replay; successful delivery resolves
  the Email dead-letter. These checks passed in
  [operational qualification run 40089452267](https://github.com/myota-platform/myota-next/actions/runs/40089452267).
- **Missing evidence:** Broker-side retry exhaustion under the deployment
  conditions is explicitly unqualified.
- **Risk:** A sustained consumer or broker failure may lose notifications or
  leave dead letters without a verified operator recovery path.
- **Next check:** Exercise retry exhaustion and recovery against the isolated
  deployment's broker topology and settings; record terminal state, metrics,
  alerting, and audited redrive evidence.
- **Tracked by:** [Issue #15](https://github.com/myota-platform/myota-next/issues/15).
- **Sources:** [workers and operations, lines 90–95](parity/workers-operations.md#L90).

### L-07 — Qualify large PBF imports and less common OSM geometry

- **Owner:** Geodata importer and worker (`apps/geodata-importer/`,
  `apps/geodata/`, `apps/geodata-worker/`).
- **Class:** Performance and compatibility qualification.
- **Reference behavior:** The configured PBF decoder and pinned importer retain
  expected feature counts, source identifiers, hashes, geometry, memory bounds,
  and failure messages at supported scale.
- **Current implementation and evidence:** The Python-generated PBF parity fixture
  covers tagged nodes, linear and closed ways, and a multipolygon relation with an
  inner ring. A second fixture compares a disjoint multipart protected-area relation
  with two outer components and one inner ring against PyOsmium 4.3.2, including its
  feature hash. A separate PyOsmium 4.3.2 reference fixture verifies a closed way
  carrying both line and area tags emits both expected geometries with Python-compatible
  hashes; another fixture covers a `route=hiking` way without a highway tag. A
  PyOsmium 4.3.2 tag-matrix fixture now checks all nine accepted tag values on nodes,
  each of the five accepted line-way tags, the remaining area-way tags, and all 17
  Python-compatible outputs and hashes. The
  manually triggered RSS suite now executes generated 50,000-,
  250,000-, and 300,000-feature workloads; the 300,000 case stays within the existing
  192 MiB Node-plus-osmium process-tree growth bound. The runner previously selected a
  suite name rather than its test names, so those checks had been skipped; the runner
  fix now executes all three cases.
- **Missing evidence:** Inputs above 300,000 features and less common OSM geometries
  beyond the checked-in relation fixture still need qualification; RSS scopes are not
  directly comparable with Python's absolute process-RSS measurements.
- **Risk:** Large or unusual source files may exhaust memory, exceed supported
  bounds, or produce different entities than the reference importer.
- **Next check:** Extend correctness and resource workloads beyond 300,000 features,
  add other less common OSM types, and document comparable versus non-comparable RSS
  scopes before setting production caps.
- **Tracked by:** [Issue #18](https://github.com/myota-platform/myota-next/issues/18).
- **Sources:** [Geodata parity, lines 140–171](parity/geodata.md#L140);
  [completion criteria, lines 15–17](parity/completion-criteria.md#L15).

### L-09 — Qualify Geodata worker outages during claim and processing

- **Owner:** Geodata API/worker (`apps/geodata/`,
  `apps/geodata-worker/`, `tools/run-geodata-worker-recovery.mjs`).
- **Class:** Recovery/operations qualification.
- **Reference behavior:** Import preprocessing, promotion, deletion,
  enrichment, and other asynchronous work recover after process and database
  outages without duplicate side effects or lost durable state.
- **Current implementation and evidence:** CI verifies preprocessing recovery
  across PostgreSQL reconnection and settlement paths for all four work kinds;
  some settlement checks stub successful reprocessing. Live-worker checks kill
  processing workers after repository commits but before ACK for preprocessing,
  promotion, deletion, and enrichment, then verify redelivery settles without
  duplicate records. A further check kills workers after the durable claim and
  lease commit but before processing for all four work kinds, expires the lease,
  and verifies a fresh worker completes redelivery. The promotion and deletion
  fixtures contain a confirmed candidate and an existing target entity, so the
  post-commit checks verify actual entity creation and deletion. The full
  operational qualification passed in
  [run 40084571566](https://github.com/myota-platform/myota-next/actions/runs/40084571566).
- **Missing evidence:** Object-store outage/recovery for consumers beyond the
  preprocessing path and deployment recovery remain unqualified. The local
  SeaweedFS volume-loss case is now covered under L-13, but does not qualify the
  deployed storage topology. Some broker settlement checks still stub
  successful reprocessing.
- **Risk:** Import, promotion, deletion, enrichment, or retention work may be
  stranded or repeated after a crash or database outage.
- **Next check:** Extend object-store outage and retry checks to relevant
  consumers, then repeat the recovery scenarios against the isolated deployment.
- **Tracked by:** [Issue #16](https://github.com/myota-platform/myota-next/issues/16).
- **Sources:** [Geodata parity, lines 18–25](parity/geodata.md#L18);
  [workers and operations, lines 168–190](parity/workers-operations.md#L168).

### L-10 — Qualify live Geodata sources before enabling scheduled fetching

- **Owner:** Geodata importer and deployment (`apps/geodata-importer/`,
  `deploy/helm/myota-next/`).
- **Class:** Operations and security qualification.
- **Reference behavior:** Scheduled imports use authorized HTTPS sources,
  reviewed host allowlists and licenses, safe scheduling, bounded responses,
  and recoverable behavior during source outages.
- **Current implementation and evidence:** The importer is opt-in, enforces
  exact/subdomain allowlists, rejects redirects and URL credentials, and has
  one-shot, scheduled, and local fixture checks.
- **Missing evidence:** Real source domains and licenses, production source
  configuration, live outage behavior, and deployment recovery remain
  unqualified.
- **Risk:** Unreviewed sources can violate licensing, fetch unintended hosts,
  or leave scheduled imports in an unclear state after outages.
- **Next check:** Review each proposed source and license, exercise source
  failure and recovery with the intended deployment allowlist and limits, and
  keep the importer disabled until those checks pass.
- **Tracked by:** [Issue #18](https://github.com/myota-platform/myota-next/issues/18).
- **Sources:** [Geodata parity, lines 375–390](parity/geodata.md#L375);
  [Geodata importer operations guide](operations/geodata-importer.md).

### L-11 — Complete browser compatibility coverage for Admin workflows

- **Owner:** Admin web (`web/admin/`) and owning API services.
- **Class:** Browser/workflow qualification.
- **Reference behavior:** Primary Admin workflows return accurate persisted
  outcomes and recover correctly from authorization, validation, conflict,
  upload, and downstream-service failures.
- **Current implementation and evidence:** The Phase 3 audit maps every Admin
  mutation with launch impact to a live browser path through Gateway and the
  owning service. Coverage includes Identity account creation/edit/role grants,
  export/anonymization and callsigns; programme/category creation, edits and
  archive; policy/content/award review and publication; Activity corrections
  and recalculation; and Geodata review, imports, geometry, conflation, deletion,
  maps and refresh schedules. The route-to-workflow evidence and accepted
  read-only omissions are recorded in
  [Web applications: secondary workflow evidence](parity/web-applications.md#secondary-workflow-evidence-and-disposition).
  All 14 user-facing Admin routes pass Axe and horizontal-overflow checks at
  390px and 1440px, with keyboard navigation coverage. Live permission denial
  verifies a least-privilege account cannot access the Identity route or
  protected endpoint. [Node CI run 40111255807](https://github.com/myota-platform/myota-next/actions/runs/40111255807)
  passed all 70 browser checks and the other configured checks against isolated
  services.
- **Reviewed omissions:** Dashboard metric-source outage combinations, every
  table filter/page-size combination, and monitoring/legacy redirect pages are
  read-only presentation states. They do not create a new persistent mutation or
  authorization boundary; the underlying owner workflows and access denial are
  covered live, and the browser surfaces have route-level Axe, keyboard, and
  viewport checks. These bounded omissions are accepted for this launch phase.
- **Risk:** The accepted gaps can affect secondary read-only presentation, but
  do not leave an unqualified launch-scope write or permission-changing action.
- **Next check:** Reopen L-11 if a new high-impact Admin mutation is added without
  an end-to-end browser path. Isolated-deployment primary-journey qualification
  remains under Phase 6 issue #10.
- **Tracked by:** The completed primary-workflow evidence is in
  [Issue #20](https://github.com/myota-platform/myota-next/issues/20). Secondary
  workflow coverage and accepted omissions are dispositioned in
  [Phase 3 follow-up issue #22](https://github.com/myota-platform/myota-next/issues/22),
  under [Phase 3 issue #7](https://github.com/myota-platform/myota-next/issues/7).
- **Sources:** [Web applications: secondary workflow evidence](parity/web-applications.md#secondary-workflow-evidence-and-disposition);
  [completion criteria, lines 19–25](parity/completion-criteria.md#L19).

### L-12 — Complete accessibility, visual, and Participant browser review

- **Owner:** Admin and Participant web (`web/admin/`, `web/participant/`).
- **Class:** Browser/workflow qualification.
- **Reference behavior:** Primary Admin and Participant journeys are usable
  with keyboard and assistive technology, at supported viewport sizes, and
  present accessible loading, error, and recovery states.
- **Current implementation and evidence:** Orca 46.1 with Chromium 156.0.8078.4
  reviewed secondary high-impact Admin programme creation/archive, Identity
  least-privilege account creation and deactivation/anonymization, Geodata
  deletion and retry/completion, custom role creation, and award
  submission/review/publication. Participant callsign
  evidence/primary retirement and profile-image save were also reviewed. Orca
  announced the field names, dialog names and consequences, failure/retry
  feedback, and completion messages. The review caught a misspelled award
  submission announcement; it is corrected to “Award submitted.” and has a
  browser regression assertion. No critical blocker remains in the reviewed
  flows. Earlier reviews fixed the Participant skip link and made Activity
  rebuild job status a live region. The route-to-review record is in
  [Web applications: secondary workflow evidence](parity/web-applications.md#secondary-workflow-evidence-and-disposition).
  All 14 user-facing Admin routes and primary Participant views have Axe and
  viewport evidence, and focused browser runs of the destructive, permissions,
  award, callsign, and image flows passed.
- **Reviewed omissions:** Unreviewed AT states are limited to read-only
  dashboard/filter/paging variations and external monitoring/compatibility
  redirects; these have no launch-scope mutation, and their structure remains
  covered by route-level Axe and keyboard checks. Deployment integration for
  primary journeys is explicitly tracked separately by Phase 6 issue #10.
- **Risk:** Accepted residual risk is limited to secondary read-only
  presentation; no unresolved critical accessibility or workflow blocker was
  found for the agreed launch scope.
- **Next check:** Reopen L-12 if the read-only surfaces gain mutations or a new
  high-impact screen-reader flow is added. Keep isolated-deployment review under
  issue #10; that scope is not a Phase 3 secondary-browser blocker.
- **Tracked by:** Completed primary Admin and Participant review is recorded in
  [issues #20](https://github.com/myota-platform/myota-next/issues/20) and
  [#21](https://github.com/myota-platform/myota-next/issues/21). Secondary
  screen-reader evidence and dispositions are recorded under
  [Phase 3 follow-up issue #22](https://github.com/myota-platform/myota-next/issues/22),
  in [Phase 3 issue #7](https://github.com/myota-platform/myota-next/issues/7).
- **Sources:** [Web applications: secondary workflow evidence](parity/web-applications.md#secondary-workflow-evidence-and-disposition);
  [completion criteria, lines 19–25](parity/completion-criteria.md#L19).

### L-13 — Qualify object-store failover, data loss, and all consumers

- **Owner:** Geodata and other object-store consumers, plus deployment
  operations (`apps/geodata/`, relevant upload consumers, storage deployment).
- **Class:** Recovery/operations qualification.
- **Reference behavior:** Interrupted writes and object-store failures remain
  safe to retry; the deployed persistence and recovery procedure protects
  objects used by imports and other workflows.
- **Current implementation and evidence:** CI stops a pinned SeaweedFS process
  during a multipart upload, retains its local volume, retries, and verifies
  the queued import. It also deletes the local data volume after uploading both
  parts of a second multipart upload; completion then marks the session
  `FAILED`, creates no import run or outbox event, and directs the caller to
  start a new upload. The fixture cleans up both sessions. These storage cases
  passed in [operational qualification run 40098768950](https://github.com/myota-platform/myota-next/actions/runs/40098768950).
  That run also verifies Geodata preprocessing retries a temporary object-store
  outage and retention repeats safe deletion after a database interruption.
  Activity ADIF and certificate rendering retry temporary object-store failures;
  checks verify no partial QSO or ready-artifact effect is committed before the
  successful retry.
- **Additional consumer check:** Node CI verifies a failed Identity profile-image
  S3 write rolls back without replacing the existing image reference; the test
  uses mocked database and object-store clients. See [Node CI run 40098386128](https://github.com/myota-platform/myota-next/actions/runs/40098386128).
- **Missing evidence:** Clustered failover, recovery after permanent volume loss
  in the deployed storage topology, production recovery procedures, and outage
  behavior for remaining object-store consumers, including integrated and
  deployed Identity profile-image recovery, are not covered by those checks. A
  focused profile-image unit test verifies a failed S3 write rolls back without
  replacing the existing image reference.
- **Risk:** Uploaded or generated objects can be lost or orphaned while their
  database references remain, or recovery may require undocumented manual work.
- **Next check:** Rehearse backup, restore, failover, permanent-volume-loss
  recovery, and safe retry against the selected deployment storage; exercise
  remaining consumer outage paths and document operator actions and evidence.
- **Tracked by:** [Activity issue #15](https://github.com/myota-platform/myota-next/issues/15)
  and [Geodata issue #16](https://github.com/myota-platform/myota-next/issues/16).
- **Sources:** [workers and operations, lines 192–196](parity/workers-operations.md#L192);
  [object-store recovery guide, lines 10–15](operations/object-store-recovery.md#L10).

### L-14 — Qualify deployment-level NATS recovery

- **Owner:** NATS and owner-scoped outbox/worker operations.
- **Class:** Recovery/operations qualification.
- **Reference behavior:** APIs, relays, and workers recover from interruption of
  the currently configured single NATS/JetStream instance and settle durable
  messages only after owner-database state changes.
- **Current implementation and evidence:** CI covers process restart with a
  retained local file store and three-node JetStream leader changes for several
  worker and relay paths.
- **Missing evidence:** Recovery of the configured NATS/JetStream instance in
  the active isolated Helm deployment remains unqualified. CI broker leader
  failover is evidence for worker behavior, not a requirement for the launch
  topology.
- **Risk:** A deployed single-instance broker failure may stop APIs/workers,
  cause duplicate publication, or leave acknowledged work unsettled.
- **Next check:** Fault-inject a restart or connection interruption of the
  configured broker in the isolated Helm deployment; verify reconnect,
  settlement, relay idempotency, alerting, and operator recovery. Clustered
  NATS failover is deferred to standalone low-priority
  [myota-deploy#67](https://github.com/myota-platform/myota-deploy/issues/67).
- **Tracked by:** [Issue #17](https://github.com/myota-platform/myota-next/issues/17).
- **Sources:** [workers and operations, lines 230–235](parity/workers-operations.md#L230);
  [outbox recovery guide, lines 33–38](operations/outbox-recovery.md#L33).

### L-15 — Qualify single-instance PostgreSQL recovery in deployment

- **Owner:** Core, Activity, and Geodata database operations.
- **Class:** Recovery/operations qualification.
- **Reference behavior:** Each API, relay, and worker recovers when its
  currently configured owner-database instance restarts or loses connectivity,
  without cross-owner transactions, lost committed writes, or duplicate effects.
- **Current implementation and evidence:** CI covers transient PostgreSQL
  connection loss and process restart for selected worker and outbox paths.
- **Missing evidence:** Recovery after restarting each configured PostgreSQL
  instance in the active isolated Helm deployment remains unqualified.
- **Risk:** An instance restart can interrupt transactions or strand work across
  one or more of the three database owners.
- **Next check:** Rehearse one-at-a-time instance restart and connection loss
  for Core, Activity, and Geodata in the isolated deployment; verify transaction
  results, reconnect, worker/relay recovery, health signals, and operator steps.
  HA failover and multi-instance scaling are deferred to standalone low-priority
  [myota-deploy#67](https://github.com/myota-platform/myota-deploy/issues/67).
- **Tracked by:** [Issue #17](https://github.com/myota-platform/myota-next/issues/17).
- **Sources:** [workers and operations, lines 237–245](parity/workers-operations.md#L237);
  [completion criteria, lines 15–17](parity/completion-criteria.md#L15).

### L-16 — Rehearse database backup and restore in the target deployment

- **Owner:** Deployment and database operations (`tools/db-backup.ts`,
  `tools/db-restore.ts`, `deploy/`).
- **Class:** Recovery/operations qualification.
- **Reference behavior:** Each of Core, Activity, and Geodata can be restored
  from its checked backup with ownership, integrity, and documented
  cross-database recovery semantics.
- **Current implementation and evidence:** CI writes probe rows in all three
  disposable owner databases, backs them up, mutates them, restores, and checks
  the saved values. Restore checks checksums and explicitly is not atomic across
  all three databases.
- **Missing evidence:** Production operators still need to rehearse using their
  deployment configuration and storage. Object-store data and JetStream
  messages need separate recovery procedures.
- **Risk:** A recoverable CI script may still fail against actual credentials,
  storage, PostgreSQL configuration, or coordinated owner recovery.
- **Next check:** Rehearse backup, restore, and documented partial-failure
  recovery in the isolated deployment, including object storage and JetStream
  separately; retain evidence and operator steps.
- **Tracked by:** [Issue #10](https://github.com/myota-platform/myota-next/issues/10).
- **Sources:** [database backup/restore guide, lines 36–41](operations/database-backup-restore.md#L36);
  [completion criteria, lines 19–25](parity/completion-criteria.md#L19).

### L-17 — Complete fresh isolated deployment qualification

- **Owner:** Deployment and release operations (`deploy/helm/myota-next/`,
  `deploy/helm/myota-infrastructure/`, CI and release workflows).
- **Class:** Deployment qualification.
- **Reference behavior:** A fresh install initializes the three empty owner
  databases, serves primary user journeys, recovers safely, exposes
  observability, and can roll back to the previous immutable image digests.
- **Current implementation and evidence:** Compose, Helm, health/readiness,
  migrations, and image builds exist. CI exercises services and browser flows
  in disposable infrastructure.
- **Missing evidence:** The parity criteria separate production deployment
  qualification from API-level evidence, and the implementation plan requires
  end-to-end qualification in the Helm-backed `myota-test` release, including
  Observe instrumentation, secrets, backup/restore, and rollback.
- **Risk:** CI/Compose success can mask Helm, secret, image-provenance,
  readiness, observability, or rollback failures in the actual isolated target.
- **Next check:** Deploy immutable image digests to a fresh `myota-test`
  installation; verify empty-database migration, primary workflows, Observe,
  logs/metrics/traces/alerts, dependency recovery, backup/restore, and rollback.
- **Tracked by:** [Issue #10](https://github.com/myota-platform/myota-next/issues/10).
- **Sources:** [completion criteria, lines 15–26](parity/completion-criteria.md#L15);
  [implementation plan, Step 6](implementation-plan.md#L185);
  [Web applications, lines 261–265](parity/web-applications.md#L261).

### L-18 — Measure representative production capacity and operating bounds

- **Owner:** Activity, Geodata, and deployment operations.
- **Class:** Performance qualification.
- **Reference behavior:** Supported upload and computation workloads remain
  within documented resource, latency, concurrency, and recovery bounds under
  explicit CPU, memory, configured launch replica counts, and database-pool limits.
- **Current implementation and evidence:** Geodata has manually triggered RSS
  checks for selected GeoJSON, Shapefile, and PBF inputs; worker concurrency,
  database-pool defaults, and source limits are configurable.
- **Missing evidence:** Completion criteria leave production throughput open;
  representative Activity log/QSO ingestion, broad award calculation, and
  cross-service capacity bounds still need measurements comparable to the
  intended deployment. Existing Python/Nest RSS scopes are not always directly
  comparable.
- **Risk:** Production load can exhaust memory, pools, or broker capacity,
  producing slow or failed user workflows and unsafe retry backlogs.
- **Next check:** Measure Geodata formats and source caps, Activity log/QSO
  ingestion and award recalculation, synchronous command/selection bounds,
  broker backlog, and recovery under stated limits; set and document operating
  bounds from results.
- **Tracked by:** [Issue #18](https://github.com/myota-platform/myota-next/issues/18)
  and [Issue #19](https://github.com/myota-platform/myota-next/issues/19).
- **Sources:** [completion criteria, lines 15–17](parity/completion-criteria.md#L15);
  [Geodata parity, lines 122–151](parity/geodata.md#L122);
  [workers and operations, lines 143–145](parity/workers-operations.md#L143);
  [implementation plan, Step 5](implementation-plan.md#L154).

## Accepted limitations and explicit dispositions

### D-10 — Defer HA and multi-instance deployment beyond launch readiness

- **Owner:** Deployment and platform operations (`myota-deploy`).
- **Class:** Low-priority future infrastructure improvement.
- **Current implementation and evidence:** Launch qualification targets the
  currently configured replica counts and single-instance NATS/JetStream and
  PostgreSQL services. Local CI separately exercises three-node JetStream
  failover, but the isolated deployment does not currently provide clustered
  broker or database topology.
- **Disposition and impact:** HA PostgreSQL, clustered NATS/JetStream, and
  horizontal multi-instance service qualification are not prerequisites for
  Phases 1–6 or parent issue #4. These improvements are tracked as the
  unparented, unphased low-priority task
  [myota-deploy#67](https://github.com/myota-platform/myota-deploy/issues/67).
  This defers topology-level availability and scale-out guarantees; single-
  instance restart/reconnect recovery remains required under L-14/L-15.
- **Next check:** Reopen as a launch gate only if product or operations adopts
  an HA or multi-instance requirement for the initial release. Otherwise plan
  it independently under #67.
- **Sources:** [Phase 4 issue #17](https://github.com/myota-platform/myota-next/issues/17);
  [future deployment task #67](https://github.com/myota-platform/myota-deploy/issues/67).

### D-04 — Identity and Programme parity is qualified by material workflows

- **Owner:** Identity and Programmes (`apps/identity/`, `apps/programmes/`).
- **Class:** Functional-parity scope disposition.
- **Current implementation and evidence:** The pinned handler test inventory
  and parity matrix have been compared with focused Nest fixtures for account
  creation and idempotency, role authority, callsign lifecycle, profile/image
  handling, recovery/session revocation, and Programme catalogue, content, and
  policy lifecycle operations. Gateway and browser workflows cover persisted
  account creation/replay and Programme administration. The owning parity page
  links the detailed comparisons and CI evidence.
- **Disposition and impact:** The launch completion criteria require common
  workflows plus shared authorization, validation, and conflict behavior; they
  do not require a test for every cross-product of valid and invalid fields.
  Those material outcomes are covered, and the latest source comparison found
  no additional confirmed mismatch. New concrete mismatches reopen this scope.
  Deployment SMTP trust-root qualification remains open under L-02 / #13.
- **Next check:** Reopen only when a concrete material reference difference is
  identified; keep deployed email qualification in its separate launch issue.
- **Sources:** [Identity and Programmes parity](parity/identity-programmes.md);
  [completion criteria, lines 1–18](parity/completion-criteria.md#L1).

### D-05 — Activity parity is qualified by complete common workflows

- **Owner:** Activity APIs and workers (`apps/activity/`,
  `apps/activity-worker/`, `apps/activity-notifications/`).
- **Class:** Functional-parity scope disposition.
- **Current implementation and evidence:** Focused reference fixtures and live
  Gateway/browser workflows cover activation, QSO writes and corrections, ADIF
  upload and processing, public results, award lifecycle and calculation,
  notifications, and durable job status. The Activity parity page links
  service/worker checks and persisted-record browser evidence.
- **Disposition and impact:** The common workflows and shared authorization,
  validation, conflict, and failure-order outcomes satisfy the functional
  parity criteria. Exhaustive combinations are not individually qualified
  without a concrete material mismatch. Process-loss, deployment retry, and
  capacity qualification remain separately open under L-04, L-05, and #19.
- **Next check:** Reopen for a specific reference mismatch; retain recovery and
  capacity evidence in the owning launch issues.
- **Sources:** [Activity parity](parity/activity.md);
  [completion criteria, lines 1–18](parity/completion-criteria.md#L1).

### D-06 — Geodata parity is qualified by material workflows and source formats

- **Owner:** Geodata API, worker, importer, and Admin workflows.
- **Class:** Functional-parity scope disposition.
- **Current implementation and evidence:** Live Gateway/Admin browser workflows
  cover every configured import format, persisted upload/import status, candidate
  review, and synchronous all-or-nothing selected promotion. Reference fixtures
  cover every supported PyShp shape family, all required OSM tag families and
  emitted point/line/area forms, representative projected CRS families, ESRI and
  WKT2 ED50 definitions, and the Spain-specific IGN datum grid. Code, contract,
  repository, worker, and browser evidence is linked from the
  [Geodata parity page](parity/geodata.md); the complete CI run for the latest
  fixture set passed in [run 39979336005](https://github.com/myota-platform/myota-next/actions/runs/39979336005).
- **Disposition and impact:** The launch criteria require complete common
  workflows and material outcomes, not a fixture for every combination in the
  4,758-entry EPSG table or every uncommon OSM relation/member encoding. Those
  unenumerated combinations have no confirmed material mismatch; large-input
  bounds and less-common OSM scale cases remain tracked separately in L-07 / #18.
  The NestJS importer deliberately applies the official Spanish IGN ED50 grid
  when available, which can differ from the legacy PyProj default operation in
  overlapping operation areas; this is a target extension that selects the
  source-specific Spanish grid instead of the legacy global operation, and is
  explicitly covered by grid-operation fixtures. Outside the grid coverage,
  the bundled EPSG definition is retained.
- **Next check:** Reopen for a concrete material importer, projection, payload,
  or mutation mismatch, or when an approved live source requires a currently
  unqualified CRS/grid operation. Keep capacity and live-source safeguards in
  their separate launch issues.
- **Sources:** [Geodata parity](parity/geodata.md);
  [completion criteria, lines 1–18](parity/completion-criteria.md#L1);
  [issue #14](https://github.com/myota-platform/myota-next/issues/14).

### D-01 — Nest-only routes are extensions, not parity claims

- **Owner:** API and contracts.
- **Class:** Optional extension / accepted scope boundary.
- **Current implementation and evidence:** The route traceability lists the
  target controllers and seven method/path pairs that have no pinned Python
  counterpart; current Nest controllers and service routes live under
  `apps/identity/`, `apps/programmes/`, `apps/activity/`, and `apps/geodata/`.
- **Disposition and impact:** Seven Nest-only route pairs are documented as
  target extensions. Their presence does not prove legacy behavior; parity
  claims remain limited to pinned reference routes and evidenced workflows.
  The CSV ingestion route is likewise an extension. No parity work is assigned
  unless a separate product decision changes that scope.
- **Next check:** Keep these routes labeled as extensions in route traceability
  and avoid including them in upstream parity totals.
- **Sources:** [HTTP compatibility, lines 58–69](parity/http.md#L58);
  [Activity parity, lines 205–210](parity/activity.md#L205).

### D-02 — Migration from the former platform is out of scope

- **Owner:** Product and data migration.
- **Class:** Accepted limitation / out of scope.
- **Current implementation and evidence:** New owner schemas are created by
  `deploy/db/migrations/`; backup/restore operates on the new Core, Activity,
  and Geodata databases and does not transform the former Python schema.
- **Disposition and impact:** The new platform starts from empty Core,
  Activity, and Geodata databases. Existing Python-system data will not be
  transferred as part of this launch plan; historical records will therefore
  not appear in the fresh installation unless separately handled.
- **Next check:** Keep cutover and data-transfer planning separate from
  functional and isolated-deployment qualification.
- **Sources:** [completion criteria, lines 19–22](parity/completion-criteria.md#L19);
  [database backup/restore guide, lines 30–34](operations/database-backup-restore.md#L30).

### D-03 — Activity job-read authorization follows the pinned reference

- **Owner:** Activity API and contracts (`apps/activity/`, `contracts/`).
- **Class:** Accepted reference-compatible behavior with contract discrepancy.
- **Current implementation and evidence:** The ADIF and award job-status
  routes are implemented by `apps/activity/src/adif-import.controller.ts` and
  `apps/activity/src/awards.controller.ts`; the compatibility comparison is
  recorded in the Activity parity page.
- **Disposition and impact:** ADIF and award job-status reads do not check
  authorization in the pinned Python handler, and Nest preserves that behavior,
  although the OpenAPI declaration says bearer authorization. This is not a
  Nest-versus-reference parity gap, but it is a security-sensitive contract
  mismatch. This launch plan preserves the pinned Python behavior for parity
  and does not change the access policy. Any different security or contract
  policy requires a separate reviewed decision and compatibility change.
- **Next check:** Keep the discrepancy visible in the Activity parity page and
  do not change authorization as part of unrelated parity work.
- **Sources:** [Activity parity, lines 272–277](parity/activity.md#L272).

## Source coverage audit

Every parity and operations Markdown document reviewed is mapped below. Shared
status statements are consolidated into the ledger items above rather than
duplicated as separate work.

- [Parity matrix](parity-matrix.md): L-02, L-17 through L-18, and
  D-01, D-02, D-04, D-05, and D-06.
- [HTTP compatibility](parity/http.md): D-01.
- [Identity and Programmes](parity/identity-programmes.md): L-02, D-04.
- [Activity](parity/activity.md): L-04, L-05, D-01, D-03, D-05.
- [Geodata](parity/geodata.md): D-06, L-07, L-09, L-10, L-13, and L-18.
- [Web applications](parity/web-applications.md): L-11, L-12, L-17.
- [Workers and operations](parity/workers-operations.md): L-04, L-05,
  L-09, L-13 through L-15, L-18.
- [Completion criteria](parity/completion-criteria.md): L-07, L-11, L-12,
  L-15 through L-18, D-02, D-04, D-05, and D-06.
- [Database backup and restore](operations/database-backup-restore.md):
  L-16, D-02.
- [Geodata source importer](operations/geodata-importer.md): L-10.
- [Object-store recovery](operations/object-store-recovery.md): L-13.
- [Outbox dead-letter recovery](operations/outbox-recovery.md): L-14.

The ledger excludes verified behavior statements that have no open or
qualification status. For example, the documented MultiPatch Shapefile error
matches the pinned PyShp behavior; it is not recorded as a gap. Route maps,
unit tests, builds, CI-only infrastructure, and process-restart checks are not
treated as evidence for broader workflow, deployment, or production claims.
