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

These checks establish owner-database transaction outcomes, deployed NestJS
connection recovery, readiness signals, NATS redelivery, and Core outbox
recovery. They do not yet exercise an in-flight Activity or Geodata business
job through a deployed broker/database interruption, or prove its owner-state
commit precedes ACK. Object-store outage recovery across all consumers and
deployed notification/Email retry exhaustion and redrive also remain open.
The Email worker is explicitly disabled in this test release, so CI Email
recovery checks are not deployment evidence. See [Activity recovery](../parity/workers-operations.md)
and the [remaining work ledger](../remaining-work-ledger.md) for those gaps.
