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

### L-01 — Complete Identity and Programme sequence compatibility coverage

- **Owner:** Identity and Programmes (`apps/identity/`, `apps/programmes/`).
- **Class:** Compatibility qualification.
- **Reference behavior:** Pinned Python request, authorization, validation,
  conflict, recovery, callsign, and lifecycle ordering where it affects access
  or persisted state.
- **Current implementation and evidence:** Identity behavior is implemented in
  the owning services and has focused fixtures such as
  `apps/identity/src/identity-account.creation.spec.ts`,
  `identity-account.roles.spec.ts`, `identity-callsign.lifecycle.spec.ts`,
  `auth.recovery.spec.ts`, `auth.logout.spec.ts`,
  `auth.profile.compatibility.spec.ts`, and
  `identity-account.validation-order.spec.ts`. A logout fixture now also pins
  rollback when access-token validation fails after refresh-session revocation
  is attempted, and recovery coverage now verifies expired-token rejection has
  no credential or session side effects. Role-grant coverage also verifies an
  Identity administrator may retain or revoke an equal-authority role already
  on another account while being unable to grant a new one; a global operator
  cannot grant the equal global role or remove the last active global-operator
  assignment. Existing reference comparisons are
  summarized in
  [Identity and Programmes parity](parity/identity-programmes.md).
  The own-profile fixture now also compares URL normalization, field clearing,
  unsafe-value rejection, and transaction rollback with the Python contract.
  Programme service fixtures also pin invalid-status precedence and the archive
  action's ignored fields, unchanged policy version, and event payload in
  `apps/programmes/src/programmes.service.compatibility.spec.ts`. The new
  `apps/programmes/src/programme-entity-type.compatibility.spec.ts` covers shared
  catalogue assignments, assignment isolation, geometry-type normalization, and
  stable category codes. A new content-save fixture also pins cross-programme
  ownership validation before required-field checks and required fields before
  lifecycle-state checks, matching the Python save handler.
- **Missing evidence:** The source page explicitly says broader account,
  callsign, recovery, and authorization sequences still need automated
  compatibility coverage. The live concurrent normalized-email creation check
  has been added but still needs its isolated PostgreSQL execution. The ledger
  does not infer coverage from adjacent examples.
- **Risk:** A sequence or precedence difference could grant access, retain an
  invalid session, or persist the wrong callsign/account state.
- **Next check:** Compare remaining material Identity and Programme handler
  sequences with the pinned reference; add a focused fixture or workflow for
  each uncovered material outcome, run the concurrent-email live check, then
  link the evidence in the parity page.
- **Tracked by:** [Issue #11](https://github.com/myota-platform/myota-next/issues/11).
- **Sources:** [Identity and Programmes, line 167](parity/identity-programmes.md#L167);
  [completion criteria, lines 9–17](parity/completion-criteria.md#L9).

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

### L-03 — Close broader Activity compatibility gaps

- **Owner:** Activity API and workers (`apps/activity/`,
  `apps/activity-worker/`, `apps/activity-notifications/`).
- **Class:** Product compatibility qualification.
- **Reference behavior:** Activation and QSO writes/corrections, ADIF and QSO
  ingestion, public results, awards, notifications, and job status follow the
  pinned Python behavior for payloads, ordering, authorization, persistence,
  and failure outcomes.
- **Current implementation and evidence:** The Activity parity page records
  focused fixtures and live workflows for QSO correction, imports, awards,
  notifications, public results, and job processing. Relevant code includes
  `apps/activity/src/activity.service.ts`, `qso-ingestion.controller.ts`,
  `awards.service.ts`, and `apps/activity-worker/src/activity-worker.service.ts`.
  ADIF upload fixtures now also verify malware detection and scanner failure stop
  before object storage and durable job creation, and operator authorization precedes
  base64 type validation with the reference's denial detail. A QSO repository fixture pins
  duplicate insertion to return the existing QSO without repeating aggregate,
  outbox, or award-recalculation side effects. Awards service coverage also pins
  synchronous single-subject progress against asynchronous broad recalculation;
  a worker fixture pins per-record normalization errors ahead of closed-activation
  errors before any QSO write and verifies an out-of-window later record prevents
  insertion of the entire QSO batch. The ADIF worker fixture also confirms an
  out-of-window later record prevents all QSO inserts and leaves import completion
  untouched. ADIF batch insert and subsequent aggregate/outbox failures now abort and
  retry the whole transaction instead of partially salvaging or deleting individual
  rows outside the Python transaction boundary.
  A focused award-domain fixture now also pins nested AND/OR condition results
  against the Python award-condition case; a worker fixture pins requested
  award/version filtering and recalculation for every subject in that category.
  A new Activity service fixture also mirrors the Python activation authorization
  case, rejecting missing credentials and non-owner creation before repository
  writes while permitting the activation owner; it also covers non-owner QSO
  write denial and Activity-admin access before QSO mutation, plus the Python
  required-QSO-fields response before activation lookup and authentication.
- **Missing evidence:** The parity page still marks broader Activity payload
  and workflow compatibility outstanding. Existing focused cases do not prove
  all consequential combinations and failure ordering.
- **Risk:** Incomplete coverage can hide incorrect QSO writes, awards,
  authorization, duplicate side effects, or user-visible job outcomes.
- **Next check:** Use the parity matrix and handler comparison to identify the
  uncovered material workflows, then add reference-backed API and end-to-end
  evidence. Keep long log ingestion and broad award recalculation asynchronous;
  keep bounded atomic commands synchronous.
- **Tracked by:** [Issue #12](https://github.com/myota-platform/myota-next/issues/12).
- **Sources:** [Activity parity, lines 286–290](parity/activity.md#L286);
  [completion criteria, lines 9–17](parity/completion-criteria.md#L9).

### L-04 — Qualify Activity worker process-loss windows

- **Owner:** Activity worker (`apps/activity-worker/` and
  `tools/run-activity-worker-recovery.mjs`).
- **Class:** Recovery/operations qualification.
- **Reference behavior:** Leases, durable job state, side effects, dead-letter
  persistence, and JetStream settlement remain safe when a process stops at
  every consequential point.
- **Current implementation and evidence:** Recovery checks kill workers after
  lease acquisition and before processing starts for all six work kinds. Other
  checks cover redelivery after a terminal dead-letter commit and selected
  three-node leader changes.
- **Missing evidence:** Process death during side-effecting processing, after
  terminal dead-letter persistence but before broker settlement, and during
  terminal dead-letter settlement is still open.
- **Risk:** A restart could duplicate or lose a QSO/award side effect, strand a
  job, or leave a terminal message unsettled.
- **Next check:** Inject process loss in each missing window for each applicable
  work kind; verify durable final state, idempotency, lease recovery, and
  confirmed settlement or safe dead-lettering.
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
  three-node JetStream leader change.
- **Missing evidence:** Broker-side retry exhaustion under the deployment
  conditions is explicitly unqualified.
- **Risk:** A sustained consumer or broker failure may lose notifications or
  leave dead letters without a verified operator recovery path.
- **Next check:** Exercise retry exhaustion and recovery against the isolated
  deployment's broker topology and settings; record terminal state, metrics,
  alerting, and audited redrive evidence.
- **Tracked by:** [Issue #15](https://github.com/myota-platform/myota-next/issues/15).
- **Sources:** [workers and operations, lines 90–95](parity/workers-operations.md#L90).

### L-06 — Finish Geodata payload and workflow compatibility qualification

- **Owner:** Geodata (`apps/geodata/`, `apps/geodata-worker/`,
  `apps/geodata-importer/`).
- **Class:** Product compatibility qualification.
- **Reference behavior:** Import, review, metadata, geometry, category,
  location, conflation, promotion, deletion, refresh schedule, and lifecycle
  workflows preserve consequential reference payload and state behavior.
- **Current implementation and evidence:** The Geodata parity page describes
  source-specific, geometry, idempotency, review, and live workflow evidence.
  Representative implementation includes `apps/geodata/src/geodata-import.service.ts`,
  `geodata-entity-review.repository.ts`, `geodata-entity-mutation.repository.ts`,
  and `geodata-schedule.service.ts`. Admin candidate selection now applies
  synchronous, all-or-nothing promotion in the Geodata transaction through
  `GeodataPromotionRepository.promoteCandidateInTransaction`; the route contract,
  Admin feedback, and live browser qualification assert final-state responses.
  Retry is synchronous only when the locked prior queue is failed and records
  the selected candidate as failed; active and unrelated queue assignments
  remain conflicts. Promotion validation checks required fields and a nonempty
  candidate list before `targetStatus`; the synchronous limit follows target
  validation and applies after ID deduplication. Focused regression coverage pins
  the validation order, per-candidate authorization, retry eligibility, exact conflict
  response, distinct-ID cap, and duplicate-side-effect boundaries. Large import intake
  and preprocessing remain asynchronous.
- **Missing evidence:** The page explicitly leaves broader payload and workflow
  compatibility qualification outstanding; known fixture and importer gaps are
  tracked separately in L-07 and L-08. The database-backed browser qualification
  for selected promotion still needs its isolated CI run.
- **Risk:** Incorrect imported or reviewed data can affect entity geometry,
  provenance, approval, and downstream Activity records.
- **Next check:** Reconcile each remaining Geodata parity statement with the
  source-handler comparison and current fixtures; add only missing material
  compatibility cases and link their evidence.
- **Tracked by:** [Issue #14](https://github.com/myota-platform/myota-next/issues/14).
- **Sources:** [Geodata parity, lines 472–475](parity/geodata.md#L472);
  [parity matrix, lines 26–35](parity-matrix.md#L26).

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
  feature hash. The manually triggered RSS suite now executes generated 50,000-,
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
- **Sources:** [Geodata parity, lines 140–151](parity/geodata.md#L140);
  [completion criteria, lines 15–17](parity/completion-criteria.md#L15).

### L-08 — Complete remaining geometry, CRS, and datum-grid fixtures

- **Owner:** Geodata importer (`apps/geodata/src/`,
  `apps/geodata-worker/src/`).
- **Class:** Compatibility qualification.
- **Reference behavior:** Geometry grouping, CRS transformation, source hash,
  ordinate handling, and datum-grid-dependent transformations match the pinned
  PyShp/PyProj reference behavior.
- **Current implementation and evidence:** Existing fixtures compare PyShp
  2.3.1 and PyProj 3.8.0 for selected WGS84, Web Mercator, dimensionality, and
  polygon cases, including EPSG:25830 with PyProj-generated input coordinates.
  EPSG:4230 and EPSG:23028 through EPSG:23038 now use the IGN Spain ED50
  horizontal grid inside its coverage; fixtures for EPSG:4230, EPSG:23030,
  and EPSG:23031 compare transformed coordinates against PyProj 3.8.0.
  A PyShp 2.3.1 PolylineZ fixture also verifies that both the
  reference and Nest parser drop Z ordinates for the GeoJSON LineString. The
  separate-outer-parts PBF relation is also compared with
  the PyOsmium 4.3.2 reference in L-07; see the linked Geodata parity evidence.
- **Missing evidence:** Other material OSM types and geometry/CRS definitions
  still need fixtures, as do datum-grid transformations for other CRSs. The
  Spanish grid fallback outside the checked-in grid's coverage also remains
  compared only with the bundled Proj4 definition.
- **Risk:** A valid source can be rejected, transformed incorrectly, or hashed
  differently, changing entity location or identity.
- **Next check:** Enumerate uncovered source geometry/CRS types, build pinned
  reference fixtures for material cases, and verify grid availability and
  outputs in the target runtime.
- **Tracked by:** [Issue #14](https://github.com/myota-platform/myota-next/issues/14).
- **Sources:** [Geodata parity, lines 250–275](parity/geodata.md#L250).

### L-09 — Qualify Geodata worker outages during claim and processing

- **Owner:** Geodata API/worker (`apps/geodata/`,
  `apps/geodata-worker/`, `tools/run-geodata-worker-recovery.mjs`).
- **Class:** Recovery/operations qualification.
- **Reference behavior:** Import preprocessing, promotion, deletion,
  enrichment, and other asynchronous work recover after process and database
  outages without duplicate side effects or lost durable state.
- **Current implementation and evidence:** CI verifies preprocessing recovery
  across PostgreSQL reconnection, settlement paths for all four work kinds,
  and JetStream leader replacement. Some settlement checks stub successful
  reprocessing.
- **Missing evidence:** Processing and process-loss windows for other Geodata
  operations remain open; full source handling is not exercised by all broker
  settlement checks.
- **Risk:** Import, promotion, deletion, enrichment, or retention work may be
  stranded or repeated after a crash or database outage.
- **Next check:** Inject process loss during claim and after side effects for
  each remaining work kind, then verify real repositories, leases, outbox state,
  retries, and final records against the isolated deployment.
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
- **Current implementation and evidence:** Browser specs cover dashboard scope,
  identity, programmes, policies, awards, Activity, Geodata imports/review,
  conflation, deletion, and schedules under `web/admin/tests/browser/`.
- **Missing evidence:** The parity page says other Admin workflows still lack
  browser-level compatibility coverage; a source route scan and isolated
  component test are not end-to-end evidence.
- **Risk:** Admin actions can appear successful while failing to persist,
  disclose scoped data, or recover from uncertain responses.
- **Next check:** Compare the Admin route/workflow inventory with live browser
  specs, select missing primary and consequential workflows, and add end-to-end
  evidence through Gateway and owning services.
- **Tracked by:** [Issue #7](https://github.com/myota-platform/myota-next/issues/7).
- **Sources:** [Web applications, lines 195–200](parity/web-applications.md#L195);
  [completion criteria, lines 19–25](parity/completion-criteria.md#L19).

### L-12 — Complete accessibility, visual, and Participant browser review

- **Owner:** Admin and Participant web (`web/admin/`, `web/participant/`).
- **Class:** Browser/workflow qualification.
- **Reference behavior:** Primary Admin and Participant journeys are usable
  with keyboard and assistive technology, at supported viewport sizes, and
  present accessible loading, error, and recovery states.
- **Current implementation and evidence:** Live browser specs exist for both
  clients, including Participant activation, QSO, profile, callsign, awards,
  and public catalogue flows.
- **Missing evidence:** Accessibility and visual review plus deployment
  integration are explicitly listed as remaining work; browser automation
  alone does not establish those checks.
- **Risk:** Users may be blocked by inaccessible controls, layout failures, or
  inaccurate feedback in the actual deployed environment.
- **Next check:** Record keyboard, focus, label, contrast, screen-reader, and
  narrow/wide viewport findings by journey; resolve blockers and rerun primary
  workflows against the isolated release.
- **Tracked by:** [Issue #7](https://github.com/myota-platform/myota-next/issues/7).
- **Sources:** [Web applications, lines 261–265](parity/web-applications.md#L261);
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
  the queued import. Geodata retention also repeats safe object deletion after
  a database interruption.
- **Missing evidence:** Clustered failover, permanent volume loss, production
  recovery procedures, and outage paths for other object-store consumers are
  not covered by those checks.
- **Risk:** Uploaded or generated objects can be lost or orphaned while their
  database references remain, or recovery may require undocumented manual work.
- **Next check:** Rehearse backup, restore, failover, permanent-volume-loss
  recovery, and safe retry for each consumer against the selected deployment
  storage; document operator actions and evidence.
- **Tracked by:** [Issue #16](https://github.com/myota-platform/myota-next/issues/16).
- **Sources:** [workers and operations, lines 192–196](parity/workers-operations.md#L192);
  [object-store recovery guide, lines 10–15](operations/object-store-recovery.md#L10).

### L-14 — Qualify deployment-level NATS recovery

- **Owner:** NATS and owner-scoped outbox/worker operations.
- **Class:** Recovery/operations qualification.
- **Reference behavior:** APIs, relays, and workers reconnect and settle durable
  messages correctly across broker failure and cluster recovery.
- **Current implementation and evidence:** CI covers process restart with a
  retained local file store and three-node JetStream leader changes for several
  worker and relay paths.
- **Missing evidence:** Deployment-level NATS recovery is explicitly
  unqualified; process restart and isolated cluster checks do not prove recovery
  for the configured deployment topology.
- **Risk:** A deployed broker failure may stop APIs/workers, cause duplicate
  publication, or leave acknowledged work unsettled.
- **Next check:** Fault-inject broker interruption and cluster recovery in the
  isolated Helm deployment; verify durable topology, reconnect, settlement,
  relay idempotency, alerting, and operator recovery.
- **Tracked by:** [Issue #17](https://github.com/myota-platform/myota-next/issues/17).
- **Sources:** [workers and operations, lines 230–235](parity/workers-operations.md#L230);
  [outbox recovery guide, lines 33–38](operations/outbox-recovery.md#L33).

### L-15 — Qualify PostgreSQL cluster failover

- **Owner:** Core, Activity, and Geodata database operations.
- **Class:** Recovery/operations qualification.
- **Reference behavior:** Each API, relay, and worker recovers from database
  failover without cross-owner transactions, lost writes, or duplicate effects.
- **Current implementation and evidence:** CI covers transient PostgreSQL
  connection loss and process restart for selected worker and outbox paths.
- **Missing evidence:** PostgreSQL cluster failover remains explicitly
  unqualified; process restarts and fault-proxy disconnects do not prove
  failover behavior of the target cluster.
- **Risk:** Failover can interrupt transactions or strand work across one or
  more of the three database owners.
- **Next check:** Rehearse cluster failover for Core, Activity, and Geodata in
  the isolated deployment; verify transaction results, reconnect, worker/relay
  recovery, health signals, and operator procedures per owner.
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
  explicit CPU, memory, replica, and database-pool limits.
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

- [Parity matrix](parity-matrix.md): L-01 through L-03, L-06, L-17 through
  L-18, and D-01 through D-02.
- [HTTP compatibility](parity/http.md): D-01.
- [Identity and Programmes](parity/identity-programmes.md): L-01, L-02.
- [Activity](parity/activity.md): L-03 through L-05, D-01, D-03.
- [Geodata](parity/geodata.md): L-06 through L-10, L-13, L-18.
- [Web applications](parity/web-applications.md): L-11, L-12, L-17.
- [Workers and operations](parity/workers-operations.md): L-04, L-05,
  L-09, L-13 through L-15, L-18.
- [Completion criteria](parity/completion-criteria.md): L-07, L-11, L-12,
  L-15 through L-18, D-02.
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
