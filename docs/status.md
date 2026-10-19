# Implementation status

**Baseline reference:** MyOTA monorepo commit
`7f904a5130e59006765cf882956a4adbfecb17ec`.

## In place

- User-selected Node.js/NestJS runtime with Node 24 and NestJS 12.
- Nest CLI monorepo projects for Gateway, Identity, Programmes, Activity,
  Geodata, and the separate worker process slots.
- Shared `/healthz` liveness and `/readyz` readiness handlers. Identity and
  Programmes probe Core PostgreSQL, Activity probes Activity PostgreSQL, and
  Geodata probes PostGIS. Gateway readiness does not depend on a database.
- Current OpenAPI, event schemas, and three database migration baselines copied
  as compatibility references.
- First Identity slice: disabled public registration, password login, refresh
  rotation, logout revocation, recovery request/reset, current account and
  scope reads, owner-only profile updates, and paginated administrator account
  listing, account creation, role-catalogue reads, role creation, and role
  updates, account reads and active role reads for the account owner or global
  operator, and administrative account updates including profile, credentials,
  lifecycle, anonymization and role replacement. Authentication uses the existing scrypt hash format, HS256 token
  contract, persisted session, revocation, lockout and rate-limit tables.
- Transactional event helpers write domain events to the Core outbox and
  security events to both the security-event table and outbox.

## Not implemented yet

- Remaining Identity APIs, including callsign lifecycle and evidence, profile
  images, OIDC, service credentials,
  security-event reads and export. Automated
  compatibility coverage for the first auth slice is also outstanding.
- Programme, Activity, Geodata, and Gateway handlers, authorization rules,
  persistence repositories, and event/outbox behavior.
- Activity and Geodata consumers, leases, recovery, retries, and redrive.
- Admin and Participant web applications.
- Database migration runner, data transfer tooling, deployment images, and
  production observability configuration.
- Email delivery. Its source contract is recorded, but the current Identity
  producer/runtime is gated and its separate database conflicts with the
  requested three-database target until its ownership is resolved.

The empty worker entry points fail explicitly rather than pretending to
process work. Contract presence and successful builds do not count as function
parity. Track completion against the [parity matrix](parity-matrix.md).
