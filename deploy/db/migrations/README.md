# Database migrations

Apply migrations to exactly one database owner per command. The Node runner
records filenames and SHA-256 checksums in `public.myota_schema_migration`,
serializes concurrent runners with a PostgreSQL advisory lock, and commits each
migration and its record atomically:

```sh
npm run migrate:db -- --owner=core
npm run migrate:db -- --owner=activity
npm run migrate:db -- --owner=geo
```

Each command requires only that owner's URL (`CORE_DATABASE_URL`,
`ACTIVITY_DATABASE_URL`, or `GEO_DATABASE_URL`). The runner rejects changed
checksums for already applied files. Do not edit an applied migration; add a
new numbered SQL file instead.

The directories preserve three independent database owners:

- `core/` — Core PostgreSQL for Identity and Programmes.
- `activity/` — Activity PostgreSQL for activations, QSOs, awards, and jobs.
- `geo/` — Geodata PostgreSQL with PostGIS for spatial data and imports.

`001` is the initial schema snapshot for each database. It is suitable only for
a new target database. The runner does not adopt an existing schema without a
migration ledger, transfer production data, or provide rollback. Before cutover,
validate source and target counts and constraints, rehearse repeatable transfer
on disposable copies, and document rollback for each database independently.
Do not introduce cross-database foreign keys or combine the three restore
boundaries.

The original application and deployment SQL inputs are preserved as a
non-executable comparison snapshot in
[`docs/reference/migrations/`](../../../docs/reference/migrations/). The
snapshot has checksums and must not be used as an additional migration source.

`core/002` through `core/004` add Identity's relational support, backfill, and
callsign projection after the initial Core baseline. `core/005` adds the
redacted email delivery ledger to the Core owner, so email delivery does not
introduce a fourth database. The JSONB Identity snapshot remains intact;
runtime cutover is a separate gated change.
