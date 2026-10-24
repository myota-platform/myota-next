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

This release still runs legacy Python API, relay, and worker images rather
than the NestJS monorepo images. These deployed observations qualify the
configured infrastructure and legacy runtime. NestJS behavior is covered by
the monorepo integration and recovery tests, but is not yet proven by this
deployed check. The Email worker also remains unready because
`myota-test` lacks its service-client credential Secret; see
[Activity recovery](../parity/workers-operations.md) for the remaining gap.
