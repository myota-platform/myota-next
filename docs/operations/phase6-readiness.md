# Phase 6 isolated deployment readiness

**Evidence date:** 2026-10-28

**Environment:** single-node K3s `myota-test`

**Scope:** Phase 6 launch qualification. This record does not claim production
readiness or high availability.

This page tracks the deployment evidence for [Phase 6 issue #10](https://github.com/myota-platform/myota-next/issues/10).
Operating guides and qualification records are maintained in this
`myota-next` repository.

## Current release

At 2026-10-28 18:07 UTC, the Rancher-managed release was Helm revision 81,
chart `myota-next-1.1.6-testing.1189d11278f7.1`, application version
`testing-875f79a`. All 15 MyOTA Deployments were ready at their desired replica
counts on the immutable image digests recorded in
[`deploy/fleet/myota-test/values.yaml`](../../deploy/fleet/myota-test/values.yaml).
The Core, Activity, Geodata/PostGIS, JetStream, and SeaweedFS PVCs were bound.
Admin and Participant web hosts, the Admin health endpoint, and the Award JSON
reference page returned HTTP 200. The Admin Web ran at digest
`sha256:e496f35e37fc76865f50de82ad68dabbb891b2ea81d94546cb6572b53c79ccfb`.
The protected catalog rollout was verified by
[run 40741182531](https://github.com/myota-platform/myota-next/actions/runs/40741182531).
Recheck release state and digests after a later rollout.

## Qualified work packages

- **Fresh installation ([#88](https://github.com/myota-platform/myota-next/issues/88)):** initialized empty Core, Activity, and Geodata databases and new PVCs; ran migrations in owner order; confirmed database runtime roles respect owner boundaries, including denied cross-owner access. No legacy data was migrated.
- **Primary Admin and Participant workflows ([#91](https://github.com/myota-platform/myota-next/issues/91)):** qualified authenticated Admin and Participant journeys, email-verified registration, profile and callsign management, activations, QSO entry and closure, ADIF import, delegated Participant administration, and Admin award workflows. Test email was delivered to the in-cluster Mailpit sink. This evidence came from earlier test releases; the current release snapshot independently confirms service health.
- **SMTP delivery and retry ([#13](https://github.com/myota-platform/myota-next/issues/13)):** verified STARTTLS using a test-only CA and credentials, retry after transient 451 responses, exhausted-delivery settlement, audited redrive, and no duplicate send when replaying the same work ID. This does not qualify a production provider or trust chain. See [single-instance recovery](single-instance-restart-recovery.md).
- **Observe and alerting ([#90](https://github.com/myota-platform/myota-next/issues/90)):**
  all 17 Prometheus targets were up and seven MyOTA alert rules loaded and
  evaluated during qualification. API traces, forwarded logs, metrics, and an
  Activity Notifications settlement log correlated to stable service IDs and
  a request trace. The corrected test dead-letter alert and notification route
  are qualified under #262. Hosted Observe receipt is not claimed. See
  [Observe delivery evidence](observe-delivery-smoke.md) and
  [alert rules](alerts.md).
- **Outbox dead letters and Alertmanager delivery ([#262](https://github.com/myota-platform/myota-next/issues/262)):**
  six Identity event contracts and a bounded Geodata preprocessing event were
  deployed with audited handling for records whose source rows were no longer
  retained. All 71 original rows were reconciled: retained safe events were
  redriven once, and source-less rows received actor- and reason-recorded
  dispositions. At Helm revision 79, Prometheus reported
  `myota_outbox_unresolved_dead_letters=0` for Core, Activity, and Geodata; the
  MyOTA dead-letter alert was inactive in Prometheus and Alertmanager. The test
  Alertmanager route requires STARTTLS and trusts the CA key from the test-only
  `myota-smtp-qualification-server` Secret. Mailpit received synthetic firing
  and resolved notifications one minute apart. The synthetic alert was cleared,
  only those two test messages were removed, and the mailbox was empty. The
  deployment was introduced by
  [PR #271](https://github.com/myota-platform/myota-next/pull/271) and verified
  by [Rancher rollout run 40709534418](https://github.com/myota-platform/myota-next/actions/runs/40709534418).
  This qualifies the isolated test route only, not a production SMTP provider
  or trust chain.
- **Dependency recovery ([#92](https://github.com/myota-platform/myota-next/issues/92)):** verified NATS redelivery after restart, database interruption and retry settlement, SeaweedFS pod replacement with its existing PVC, and safe object-store outage outcomes across Geodata, Activity, and Identity. See [single-instance recovery](single-instance-restart-recovery.md) and [object-store recovery](object-store-recovery.md).
- **Backup and restore ([#89](https://github.com/myota-platform/myota-next/issues/89)):** restored a quiesced snapshot of the three owner databases and six object buckets into disposable targets. Counts matched across 46 Core, 27 Activity, and 66 Geodata tables. Five objects (45,173,156 bytes) passed size and SHA-256 checks; two Activity ADIF references resolved. The test release returned to 21/21 replicas with health checks at HTTP 200. This is not an accepted production RPO/RTO.
- **Rollback ([#93](https://github.com/myota-platform/myota-next/issues/93)):** rolled back an immutable worker digest and restored the current digest; readiness and authenticated sign-in passed and database/work counters were unchanged. Activity was quiescent. The procedure refuses rollback when incompatible work is pending; compatibility with a non-empty in-flight stream is not claimed.
- **Award JSON validation ([#250](https://github.com/myota-platform/myota-next/issues/250), child of [#249](https://github.com/myota-platform/myota-next/issues/249)):** Activity and Admin use the same validator in
  [`contracts/award-definition.ts`](../../contracts/award-definition.ts), with
  canonical valid and invalid fixtures under
  [`contracts/fixtures/`](../../contracts/fixtures/). Coverage includes nested
  conditions, unknown fields, numeric and layout boundaries, stored-field
  handling, partial updates, and published-version tokens. In deployed
  `myota-test` (chart `1.1.6-testing.1273bd5c19e4.1`), an invalid award create
  returned HTTP 400 with a field path in `detail`; its unique probe code was
  absent from the first 100 listed awards. A live Admin browser check showed
  the accessible `Condition JSON` error and confirmed no create request was
  sent. The check used the bootstrap administrator and left no award record.
  Deployment was verified by [run 40728104528](https://github.com/myota-platform/myota-next/actions/runs/40728104528);
  implementation is in [PR #275](https://github.com/myota-platform/myota-next/pull/275).
- **Award JSON reference ([#249](https://github.com/myota-platform/myota-next/issues/249)):**
  [PR #279](https://github.com/myota-platform/myota-next/pull/279) added a
  complete, copyable JSON example and a visible, accessible link from Admin
  Awards. The example is checked against the shared fixture and runtime
  validator; browser coverage verifies the link and reference content in
  [Node CI run 40740098340](https://github.com/myota-platform/myota-next/actions/runs/40740098340). In
  `myota-test`, the page
  [`/award-configuration-reference.html`](https://myota-admin-test.spainip.es/award-configuration-reference.html)
  returned HTTP 200 and included the complete example, condition schema, and
  `AWARD_TEXT` layout element. The deployment at chart
  `1.1.6-testing.1189d11278f7.1` was verified by
  [run 40741182531](https://github.com/myota-platform/myota-next/actions/runs/40741182531).
- **Award version creation ([#248](https://github.com/myota-platform/myota-next/issues/248)):** Admin now labels the action that creates the next draft version and explains that the published source and its issued-award references remain unchanged. Service and browser coverage passed in [PR #283](https://github.com/myota-platform/myota-next/pull/283); the Admin Web digest was deployed by [PR #284](https://github.com/myota-platform/myota-next/pull/284). Protected Rancher [run 40749348878](https://github.com/myota-platform/myota-next/actions/runs/40749348878) succeeded at chart `1.1.6-testing.645d83f4b1a4.1`, app version `testing-f6ed0b5`; all 22 Deployments were ready and the Awards page returned HTTP 200. The deployed Admin bundle contains the version action. Issue #248 is closed. This verifies version creation presentation and service behavior; award deletion and overall parent #246 qualification remain open.

## Remaining Phase 6 qualification

- **Location metadata ([#110](https://github.com/myota-platform/myota-next/issues/110), [#111](https://github.com/myota-platform/myota-next/issues/111), [#112](https://github.com/myota-platform/myota-next/issues/112)):
  on 2026-10-28, the full-catalogue asynchronous Admin backfill scanned 432
  entities, queued 430, skipped two, and failed none. All 432 later showed
  `COMPLETED` in Geodata. A repeated scan initially queued seven completed
  entities; PR #255 fixed the Admin guard and added browser coverage. The
  protected Helm upgrade to chart `1.1.6-testing.43fa7c967a90.1` completed with
  15 Deployments Ready. The verified post-fix scan reported 0 queued, 432
  skipped, and 0 failed; the database still showed `COMPLETED|432`. The release
  owner subsequently confirmed the provider credentials were rotated and the
  enrichment function was tested successfully. Issues #110 and #111 are closed;
  #112 was already closed. See the
  [location-enrichment guide](location-enrichment.md) and
  [Geodata parity record](../parity/geodata.md).
- **Password reset ([#114](https://github.com/myota-platform/myota-next/issues/114)):** deployed Mailpit delivery, valid and expired browser links, concurrent single-use token consumption, and revocation of two pre-reset access and refresh sessions have been verified. Revision 73 includes the shared per-email throttle and request-log secret exclusion. Six distinct signed client addresses produced five persisted recovery requests; the sixth created none. The `identity-api` recovery trace reached the test Observe receiver, and its reset token and link marker were absent from all `myota-test` pod logs. The mock receiver retains only trace IDs and operation names, so raw-snapshot token exclusion and hosted Observe delivery remain open.
- **Email change ([#115](https://github.com/myota-platform/myota-next/issues/115)):** deployed checks cover both-address confirmation, partial confirmation, expiry, replay, cancellation, operation mismatch, concurrent confirmation, address conflict, and transient SMTP outage/retry. Revision 73's resend API and Participant UI were checked against Mailpit: both old links were rejected, the Participant UI showed resend guidance and received both replacement messages, and cancellation removed the pending operation. A follow-up API check completed the replacement pair, confirmed the old address remained authoritative until the second link, restored the synthetic account, and removed all generated messages. The complete resend lifecycle is verified.

Additional product work remains open under #239 (Participant experience), #242
(programme-scoped entity IDs), and other Phase 6 child issues. Award lifecycle
work under #246 is complete. Do not close #10 until each remaining child issue
has current evidence and its exit criteria are met or explicitly dispositioned.

## Operational limits

- **Production backups:** no scheduled job, off-node destination, retention
  enforcement, least-privilege backup identity, or accepted production RPO/RTO
  is configured. Production backup policy requires separate operational
  decisions.
- **Permanent storage loss:** recovery after SeaweedFS PVC or node loss is not
  qualified. The test covers pod replacement with the same bound local-path
  volume; do not delete the PVC as a recovery action.
- **External telemetry:** hosted Observe delivery and external Alertmanager
  notification delivery remain unqualified.
- **High availability:** clustered PostgreSQL/NATS and multi-instance failure
  qualification are tracked outside Phase 6 under [#24](https://github.com/myota-platform/myota-next/issues/24).

These are explicit limits of the isolated single-node launch topology, not
claims of production readiness.
