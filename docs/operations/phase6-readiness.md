# Phase 6 isolated deployment readiness

**Evidence date:** 2026-10-28

**Environment:** single-node K3s `myota-test`

**Scope:** Phase 6 launch qualification. This record does not claim production
readiness or high availability.

This page tracks the deployment evidence for [Phase 6 issue #10](https://github.com/myota-platform/myota-next/issues/10).
Operating guides and qualification records are maintained in this
`myota-next` repository.

## Current release

The Rancher-managed release is Helm revision 73, chart
`myota-next-1.1.6-testing.4375882af675.1`, application version
`testing-be5f518`. All 17 Deployments are ready at their desired replica counts.
The Core, Activity, Geodata/PostGIS, JetStream, and SeaweedFS PVCs are bound.
Admin and Participant web hosts return HTTP 200; Gateway `/readyz` returns
HTTP 200. The API host root returns 404 by design. Immutable image digests are
recorded in [`deploy/fleet/myota-test/values.yaml`](../../deploy/fleet/myota-test/values.yaml).

This snapshot was rechecked on 2026-10-28. Recheck the release and its digests
before relying on the record after a later rollout.

## Qualified work packages

- **Fresh installation ([#88](https://github.com/myota-platform/myota-next/issues/88)):** initialized empty Core, Activity, and Geodata databases and new PVCs; ran migrations in owner order; confirmed database runtime roles respect owner boundaries, including denied cross-owner access. No legacy data was migrated.
- **Primary Admin and Participant workflows ([#91](https://github.com/myota-platform/myota-next/issues/91)):** qualified authenticated Admin and Participant journeys, email-verified registration, profile and callsign management, activations, QSO entry and closure, ADIF import, delegated Participant administration, and Admin award workflows. Test email was delivered to the in-cluster Mailpit sink. This evidence came from earlier test releases; the current release snapshot independently confirms service health.
- **SMTP delivery and retry ([#13](https://github.com/myota-platform/myota-next/issues/13)):** verified STARTTLS using a test-only CA and credentials, retry after transient 451 responses, exhausted-delivery settlement, audited redrive, and no duplicate send when replaying the same work ID. This does not qualify a production provider or trust chain. See [single-instance recovery](single-instance-restart-recovery.md).
- **Observe and alerting ([#90](https://github.com/myota-platform/myota-next/issues/90)):** at revision 72 all 17 Prometheus targets were up and seven MyOTA alert rules loaded and evaluated. API traces, forwarded logs, metrics, and an Activity Notifications settlement log correlated to stable service IDs and a request trace. Two dead-letter alerts were firing for existing test data. The test Alertmanager has no notification receiver; hosted Observe receipt is not claimed. See [Observe delivery evidence](observe-delivery-smoke.md) and [alert rules](alerts.md).
- **Dependency recovery ([#92](https://github.com/myota-platform/myota-next/issues/92)):** verified NATS redelivery after restart, database interruption and retry settlement, SeaweedFS pod replacement with its existing PVC, and safe object-store outage outcomes across Geodata, Activity, and Identity. See [single-instance recovery](single-instance-restart-recovery.md) and [object-store recovery](object-store-recovery.md).
- **Backup and restore ([#89](https://github.com/myota-platform/myota-next/issues/89)):** restored a quiesced snapshot of the three owner databases and six object buckets into disposable targets. Counts matched across 46 Core, 27 Activity, and 66 Geodata tables. Five objects (45,173,156 bytes) passed size and SHA-256 checks; two Activity ADIF references resolved. The test release returned to 21/21 replicas with health checks at HTTP 200. This is not an accepted production RPO/RTO.
- **Rollback ([#93](https://github.com/myota-platform/myota-next/issues/93)):** rolled back an immutable worker digest and restored the current digest; readiness and authenticated sign-in passed and database/work counters were unchanged. Activity was quiescent. The procedure refuses rollback when incompatible work is pending; compatibility with a non-empty in-flight stream is not claimed.

## Remaining Phase 6 qualification

- **Location metadata ([#110](https://github.com/myota-platform/myota-next/issues/110), [#111](https://github.com/myota-platform/myota-next/issues/111), [#112](https://github.com/myota-platform/myota-next/issues/112)):** lifecycle enrichment and the full-catalogue asynchronous Admin backfill are deployed. At revision 73, the optional `myota-geodata-enrichment` Secret is absent; the worker is Ready, normal Geodata reads return HTTP 200, and an existing entity reports `NOT_CONFIGURED`. No provider requests or backfill work were submitted. The no-credential fallback is qualified; provider-backed enrichment and bulk completion still need a test-only credential. Follow the [location-enrichment guide](location-enrichment.md).
- **Password reset ([#114](https://github.com/myota-platform/myota-next/issues/114)):** deployed Mailpit delivery, valid and expired browser links, concurrent single-use token consumption, and single-session revocation have been verified. Revision 73 includes the shared per-email throttle and request-log secret exclusion. Service tests cover attempts from multiple source addresses; deployed multi-source throttling, multi-session revocation, and telemetry-secret checks remain open.
- **Email change ([#115](https://github.com/myota-platform/myota-next/issues/115)):** deployed checks cover both-address confirmation, partial confirmation, expiry, replay, cancellation, operation mismatch, concurrent confirmation, address conflict, and transient SMTP outage/retry. Revision 73's resend API and Participant UI were checked against Mailpit: old links were rejected, a fresh current-address link recorded partial confirmation, the old address remained authoritative, and cancellation removed the pending operation. The deployed UI confirmed both replacement deliveries and cancellation. Successful completion using both replacement links remains open.

Do not close #10 until each remaining child issue has current evidence and its
exit criteria are met or explicitly dispositioned.

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
