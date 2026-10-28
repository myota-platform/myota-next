# MyOTA Next repository guidance

- Keep the Identity, Programmes, Activity, and Geodata APIs independently
  startable and deployable. Keep API gateways and background workers separate
  processes.
- Preserve exactly three primary application database targets: Core PostgreSQL
  for Identity and Programmes, Activity PostgreSQL, and Geodata PostgreSQL with
  PostGIS. Never join across targets or create cross-database foreign keys.
- Service code owns its schema, migrations, authorization, transactions, and
  retries. Use explicit SQL migrations; never enable schema synchronization in
  an application runtime.
- Keep OpenAPI and event payload compatibility anchored by `contracts/`.
  Update traceability and automated checks with each implemented operation.
- NATS is bounded transport. Persist work intent and idempotency state in the
  owning database before acknowledgement; retain lease recovery and audited
  redrive behavior.
- Keep secrets out of Git. Never use local-memory persistence as a durable
  production fallback.
- Keep `@nestjs/observe` in the root runtime dependencies so every Nest CLI
  application includes it in the shared deployment install. Initialize Observe
  at each application root and pass `ObserveInstrument` to every Nest
  application or application-context factory, including workers. Give each
  process a stable, unique `serviceId`; provide credentials through environment
  variables or deployment secrets, never source control. Reporting must remain
  disabled when Observe is not configured.
- Do not declare parity from compilation alone. Require contract, database,
  worker, browser, and recovery evidence for each completed slice.

## GitHub project tracking

- For every issue tracked in Project #2, set its Status to `In progress` when
  work starts and whenever focus moves to it. Keep an active parent issue
  `In progress` while working on its child issues.
- When work is paused or no longer active, set its Status to the appropriate
  non-active state. Set `Done` only after the issue's exit criteria are
  verified.
- Verify Project #2 status after each transition. Before ending a work
  session, make sure every issue currently being worked is marked
  `In progress`.
