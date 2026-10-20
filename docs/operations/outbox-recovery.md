# Outbox dead-letter recovery

Each owner database has its own transactional outbox and dead-letter ledger.
Use this command against one database at a time by setting
`OUTBOX_DATABASE_URL` to the Core, Activity, or Geodata connection string.
The command does not connect to or modify the other database owners.

List recent dead letters. Error text is limited to 500 characters in the
output:

```sh
OUTBOX_DATABASE_URL="$CORE_DATABASE_URL" npm run outbox:admin -- list --limit 100
```

After correcting the cause of a permanent failure, requeue an event by its
UUID. Supply the operator identity and a reason for the audit record:

```sh
OUTBOX_DATABASE_URL="$CORE_DATABASE_URL" npm run outbox:admin -- redrive \
  00000000-0000-4000-8000-000000000000 \
  --actor operator-id \
  --reason "Corrected the event schema and verified the consumer contract"
```

Replace the connection string with the owning database and the UUID with the
actual dead-letter event. Redrive locks the source outbox and unresolved
dead-letter rows, records the prior attempt count and error in
`outbox_redrive_audit`, resets the source event for immediate publication, and
commits both changes together. The relay resolves the dead-letter record after
JetStream acknowledges the republished event. The command does not rewrite the
event payload or clear the dead letter before successful publication.
