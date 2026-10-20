# JetStream topology

The monorepo includes a create-only provisioner for the streams and durable
consumers described by `contracts/event-registry.json`:

```sh
NATS_TOPOLOGY_APPLY=1 npm run provision:jetstream
```

The command requires reviewed finite capacity settings. For the default
`NATS_TOPOLOGY_SCOPE=all`, set these positive integer values first:

- `NATS_EVENTS_MAX_BYTES`, `NATS_EVENTS_MAX_MESSAGES`,
  `NATS_EVENTS_MAX_MESSAGE_BYTES`
- `NATS_ACTIVITY_WORK_MAX_AGE_SECONDS`, `NATS_ACTIVITY_WORK_MAX_BYTES`,
  `NATS_ACTIVITY_WORK_MAX_MESSAGES`, `NATS_ACTIVITY_WORK_MAX_MESSAGE_BYTES`
- `NATS_GEODATA_WORK_MAX_AGE_SECONDS`, `NATS_GEODATA_WORK_MAX_BYTES`,
  `NATS_GEODATA_WORK_MAX_MESSAGES`, `NATS_GEODATA_WORK_MAX_MESSAGE_BYTES`
- `NATS_EMAIL_WORK_MAX_AGE_SECONDS`, `NATS_EMAIL_WORK_MAX_BYTES`,
  `NATS_EMAIL_WORK_MAX_MESSAGES`, `NATS_EMAIL_WORK_MAX_MESSAGE_BYTES`

The facts stream has a fixed 30-day age limit. Work stream limits must come
from deployment capacity and recovery planning; the tool has no production
capacity defaults. `NATS_URL` defaults to `nats://nats:4222`.

`NATS_TOPOLOGY_SCOPE` may be set to `activity-work`, `geodata-work`, or
`email-work` to provision only that stream and its registered durables. These
scopes require only that stream's capacity settings. The default `all` scope
includes the facts stream, all three work streams, the Activity notification
durable, and registered work durables.

Existing streams and consumers are never updated. A missing resource is
created and then checked against the requested configuration. Any drift stops
the command with a field-level error so an operator can review a successor
resource or a separate migration. In particular,
`NATS_EVENTS_RETENTION_MIGRATION=1` is rejected; the legacy retention change
needs its own reviewed migration procedure.

Set `NATS_TOPOLOGY_APPLY=1` only when applying the reviewed settings to the
intended NATS account. Without it, the command exits before connecting.
