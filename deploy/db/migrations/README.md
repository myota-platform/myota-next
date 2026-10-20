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

## Backup and restore

The owner databases can be backed up together into one timestamped directory
with a SHA-256 manifest:

```sh
CORE_DATABASE_URL='postgresql://...' \
ACTIVITY_DATABASE_URL='postgresql://...' \
GEO_DATABASE_URL='postgresql://...' \
npm run db:backup -- ./backups
```

The scripts require PostgreSQL 16 `pg_dump` and `pg_restore` client tools. The
backup command stages all three custom-format dumps before publishing the
manifest and final directory. It does not include NATS, object storage, or
browser data. Protect backup directories as sensitive production data.

Restore is destructive. It verifies all three files and checksums before
changing a database, then requires confirmation matching the selected backup
directory:

```sh
CORE_DATABASE_URL='postgresql://...' \
ACTIVITY_DATABASE_URL='postgresql://...' \
GEO_DATABASE_URL='postgresql://...' \
MYOTA_RESTORE_CONFIRM='RESTORE myota-YYYYMMDDTHHMMSSmmmZ' \
npm run db:restore -- ./backups/myota-YYYYMMDDTHHMMSSmmmZ
```

The target database names must match their corresponding manifest entries.
Each database restore is transactional, but PostgreSQL cannot make the three
independent databases one atomic restore. If a later owner fails, restore all
three databases again from the same backup before resuming the application.
Rehearse restores on disposable databases. These scripts restore a compatible
schema snapshot; they do not migrate data between the Python and NestJS schema
versions or replace the separate cutover and rollback plan.

`001` is the initial schema snapshot for each database. It is suitable only for
a new target database. The runner does not adopt an existing schema without a
migration ledger, transfer production data, or provide rollback. Before cutover,
validate source and target counts and constraints, rehearse repeatable transfer
on disposable copies, and document rollback for each database independently.
The verified source migration history and transfer requirements are recorded
in [cross-version database transfer](../../../docs/operations/cross-version-data-transfer.md).
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
runtime cutover is a separate gated change. `core/006` backfills Programme
content records into an indexed Core table and removes the duplicate content
bucket from the Programme snapshot; lifecycle writes and outbox events then
commit together against that table. `core/007` does the same for Programme
policy drafts, keeping publication of a rules or awards draft atomic with the
Programme snapshot update. `core/008` backfills Programme records into a Core
table, removes the duplicate `items` map from the Programme snapshot, and keeps
record mutations and entity-type assignments in the same Core transaction.
`core/009` moves the shared entity-type catalogue into its own Core table and
removes the last Programme domain data bucket from the JSONB snapshot. Catalogue
updates and assigned Programme record changes commit in the same transaction.
`core/010` deletes the obsolete Programme snapshot row after all domain records
and event publication have moved to relational tables and the transactional
outbox. `core/014` preserves account-role insertion order when reads return role
arrays. Existing assignments are backfilled by creation timestamp and ID; new
assignments receive a Core-owned monotonic ordering value.

`geo/002` adds attempt-scoped import feature staging so workers can process
large inputs without retaining all prepared candidates and validation errors
in application memory. Final candidate writes and their compatible outbox
events still commit atomically.
`geo/006` stores import candidate validation notes as JSONB, converting
existing text values to JSON strings so arbitrary submitted JSON note values
round-trip through candidate reads.

`activity/002` adds an owner-scoped ordering index for bounded notification
pages without changing the existing three-database ownership model.

`activity/003` supports programme-filtered activation pages without scanning
and materializing every matching activation in the API process.
