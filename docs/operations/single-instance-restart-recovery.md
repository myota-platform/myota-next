# Single-instance restart recovery

This qualification covers the currently configured, single-instance NATS and
Core, Activity, and Geodata PostgreSQL services in the isolated Helm-backed
`myota-test` namespace. It is not an HA or clustered-failover test. Do not run
the fault-injection steps against production.

## Repeat the PostgreSQL transaction check

Run this against one database owner at a time. Use that owner's PostgreSQL
pod and database; never connect one probe to multiple owners. Choose a fresh
table name for each run.

1. Create a probe table and commit marker `1` using `psql` in the owner pod.
2. In a second `psql` session, start a transaction, insert marker `2`, and hold
   it open with `SELECT pg_sleep(120)`.
3. Delete only that owner's PostgreSQL pod. Wait for the StatefulSet to create
   a new pod with the same name and for its Ready condition.
4. Check that marker `1` remains and marker `2` is absent. The interrupted
   transaction must not be partially committed.
5. Drop the probe table and confirm that the owning API, relay, and workers are
   Ready before moving to the next database.

The `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` values are read
inside the database pod; do not print or copy their values into a command log.

## Repeat the NATS and Core relay check

Use a temporary file-backed stream with a unique subject and durable consumer.
Publish one test payload, receive it without acknowledging it, restart the
single NATS pod, and reconnect the client. The durable consumer must redeliver
the same payload with delivery count at least two. Acknowledge the redelivery
and verify both pending and acknowledgement-pending counts return to zero.
Delete the temporary consumer and stream.

For the Core outbox, use an event registered without a current consumer. Stop
the isolated NATS deployment, insert one uniquely identified outbox fact, and
wait until the relay records a retryable publish failure while the event stays
unpublished. Restore one NATS replica and verify the same outbox event becomes
published and appears once in the retained stream. Remove the exact test row
and stream message by their unique IDs after verifying the result. Confirm the
Activity and Geodata outbox relays and workers return to Ready.

## Qualification evidence

On 2026-10-24, the checks ran against Helm release `myota-test` revision 505.
For each owner database, a committed marker survived pod replacement and an
open transaction's marker was absent afterward. Each replacement pod became
Ready 11 seconds after creation; Activity's measured delete-to-Ready interval
was 13 seconds. Core, Activity, Geodata APIs, outbox relays, Activity workers,
notifications, and Geodata import processing returned Ready without pod
restarts.

The NATS file-backed stream and durable consumer restored after restart. The
unacknowledged payload was redelivered once with delivery count 2; after ACK,
`num_ack_pending` and `num_pending` were both zero. The replacement NATS pod
became Ready 2 seconds after creation.

The Core outbox relay retained a registered `programme.content.saved.v1` probe
while NATS was unavailable, recorded two retry attempts, then marked it
published after NATS returned. The retained stream contained exactly one
message with the probe event ID. The probe row and message were removed.

## NestJS deployment qualification

On 2026-10-25, the checks were repeated against isolated Helm release
`myota-test` revision 2 using the NestJS monorepo images built from
`e2dd79d`. The release has separate Core, Activity, and Geodata PostgreSQL
StatefulSets, a single file-backed NATS/JetStream server, and a SeaweedFS
object store. This remains a single-node, single-instance qualification.

For each owner database, a fresh PostgreSQL pod UID replaced the old pod while
a transaction held an uncommitted marker open. The committed marker remained
and the interrupted marker was absent after recovery; all probe tables were
removed. The replacement PostgreSQL pods became Ready within 14–16 seconds of
the restart request. Health and readiness checks returned HTTP 503 while owner
database DNS/endpoints were being restored, then returned HTTP 200. The
application readiness transitions after each new PostgreSQL pod was created
were:

| Owner database | NestJS API / worker readiness |
| --- | --- |
| Core | Identity 17 s; Programmes 14 s; Core outbox 18 s |
| Activity | Activity API 16 s; worker 15 s; notifications 16 s; Activity outbox 32 s |
| Geodata | Geodata API 16 s; worker 12 s; Geodata outbox 16 s |

Database health warnings and outbox polling errors were emitted during each
interruption. After the replacement endpoints stabilized, the API and worker
readiness checks returned HTTP 200 and a fresh `SELECT 1` through each deployed
outbox relay's configured owner-database pool succeeded. The three owner
databases remained separate.

The NATS restart check ran a Node NATS client in the deployed Core outbox pod.
Its file-backed durable consumer redelivered the unacknowledged message with
delivery count 2; after ACK, both pending and acknowledgement-pending counts
were zero. The Core outbox check held one uniquely identified registered event
while NATS was unavailable, observed retry attempts, and then confirmed the
same event was published once after NATS returned. After recovery, the NATS
monitoring endpoint listed all six configured monorepo clients: Core,
Activity, and Geodata outbox relays, Activity worker, Activity notifications,
and Geodata worker.

The same qualification interrupted an actual `QSO_INGESTION` job during its
database transaction. A test-only trigger paused the targeted QSO insert after
the deployed Activity worker had claimed the job. Replacing the Activity
PostgreSQL pod rolled back that insert: the job remained `RUNNING` on attempt 1,
the activation had no QSO, and the JetStream delivery remained unacknowledged
(`ack_pending=1`). After the lease expired, the durable redelivered the command
with delivery count 2. The worker reclaimed the same job, committed exactly
one QSO and one `activity.qso.recorded.v1` outbox event, and completed the job
on attempt 2. The activation QSO count was 1; the durable ended with both
pending counts at zero. The worker logged that it could not persist retry state
while PostgreSQL was unavailable; it did not ACK that message, so JetStream
retained it until lease recovery. The trigger intentionally paused each insert
for 90 seconds; the observed end-to-end duration is test-induced and is not a
recovery SLO.

A deployed broad award recalculation for the test programme then completed
with no explicit subject list, selected the programme's persisted subject
aggregate, and wrote progress with `qsoCount=1` and `conditionMet=false` for a
two-QSO threshold. The test activation, QSO, jobs, award definition, progress,
outbox rows, trigger, and trigger function were removed. The QSO-ingestion and
award-recalculation durables both had zero pending and acknowledgement-pending
messages after cleanup.

Two deployed business jobs were also held during a single NATS process restart.
An Activity QSO-ingestion job was in its targeted pre-insert database pause
when the NATS StatefulSet was scaled to zero and restored. Activity PostgreSQL
remained available; the worker completed the job on attempt 1, persisted one
QSO and one `activity.qso.recorded.v1` outbox event, and settled the durable.
The downstream broad award job also completed once. The QSO and award durables
had zero pending and acknowledgement-pending messages afterward; all fixture
rows and the trigger were removed.

A Geodata preprocessing job was held in its final status transaction during a
second NATS restart. The durable had one unacknowledged delivery before the
restart. The job completed as `PREPROCESSED` on attempt 1 with one candidate
and one outbox event, and the durable returned to zero pending and
acknowledgement-pending messages. The worker logged `Geodata work lease was
lost` after the transaction committed and the row had become terminal; its
failure path observed the terminal owner state and safely settled the message.
This exposed a completion-versus-heartbeat race in the worker logs, even though
the owner state and ACK outcome were correct. The source object, candidate,
import row, trigger, and fixture outbox rows were removed.

A second Geodata import was held by a test-only trigger immediately before its
final `PREPROCESSED` status update. While that transaction was open, the
Geodata PostgreSQL pod was replaced. PostgreSQL rolled back the interrupted
transaction; the worker logged that it could not persist retry state while the
database was unavailable and did not ACK the work. The restored worker waited
for the existing 900-second owner lease to expire, then redelivered and
completed the same import on attempt 2. The run ended `PREPROCESSED` with one
candidate from one feature, zero errors, and a single completion outbox event.
The durable ended with zero pending and acknowledgement-pending messages. The
measured lease wait is specific to this configured test and is not a recovery
SLO. The source object, candidate, manifest, import row, outbox rows, trigger,
and trigger function were removed.

The deployed Activity notification consumer was given a unique registered
account-created event while a temporary Activity database trigger rejected
only that event's notification insert. The consumer left it unacknowledged and
retried it twice, with both deliveries logged as failures. After the trigger
and function were removed and their absence verified, the next delivery
committed one notification and one processed-event marker, then acknowledged
the event. Pending and acknowledgement-pending counts returned to zero. The
notification and processed-event fixture rows were removed. This verifies a
transient deployed notification retry; it does not qualify retry exhaustion
or audited redrive.

These checks establish owner-database transaction outcomes, deployed NestJS
connection recovery, readiness signals, NATS redelivery, and Core outbox
recovery, Activity QSO recovery after owner-database loss, and in-flight
Activity and Geodata job settlement across NATS process interruption, and
Geodata preprocessing recovery after owner-database loss. Object-store outage
recovery across all consumers and deployed notification retry exhaustion/
redrive remain open.
The Email worker is explicitly disabled in this test release, so CI Email
recovery checks are not deployment evidence. See [Activity recovery](../parity/workers-operations.md)
and the [remaining work ledger](../remaining-work-ledger.md) for those gaps.
