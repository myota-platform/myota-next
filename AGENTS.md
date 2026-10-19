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
- Do not declare parity from compilation alone. Require contract, database,
  worker, browser, and recovery evidence for each completed slice.
