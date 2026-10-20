# Cross-version database transfer

This document records verified migration inputs and the work needed to transfer
the running Python platform into the NestJS monorepo. A read-only preflight
command checks source migration history and all six database targets. Source
and destination dump staging is implemented, but restoring the source data
into the NestJS schema is not. The existing `db:backup` and `db:restore`
commands preserve one schema version; they do not convert a Python deployment
into the NestJS schema.

Set `LEGACY_CORE_DATABASE_URL`, `LEGACY_ACTIVITY_DATABASE_URL`, and
`LEGACY_GEO_DATABASE_URL` to the Python source databases, and set
`CORE_DATABASE_URL`, `ACTIVITY_DATABASE_URL`, and `GEO_DATABASE_URL` to the
NestJS destinations. Then run:

```sh
npm run db:transfer:preflight
```

The command makes read-only PostgreSQL connections. It requires six distinct
host/port/database targets, verifies the source migration ledger and known
checksums for each owner, checks that source ACL roles exist on the matching
destination, verifies PostGIS availability, and reports destination
migration-ledger shape and application relation counts. It does not modify
either side.

Stage source dumps and destination recovery dumps in a new private directory:

```sh
npm run db:transfer:stage -- --archive-dir=./backups/myota-transfer-20261020
```

The command runs preflight again, writes six PostgreSQL custom-format dumps and
a SHA-256 manifest containing the preflight report, and verifies each archive
is readable. It refuses an existing output directory. The files contain
database data; protect and retain them as sensitive backups. Staging does not
restore or modify a database.

## Database owners

Transfer each owner independently and keep the three destinations distinct:

| Owner    | Source contents                              | NestJS destination              |
| -------- | -------------------------------------------- | ------------------------------- |
| Core     | Identity and Programme data                  | Core PostgreSQL                 |
| Activity | Activations, QSOs, awards, and Activity work | Activity PostgreSQL             |
| Geodata  | Entities, imports, reviews, and Geodata work | Geodata PostgreSQL with PostGIS |

Application IDs and event references remain opaque across owners. The transfer
must not create cross-database foreign keys or join data across these targets.

## Verified migration history

The current Python checkout uses `deploy/db/migrations/run.sh` and records
`migration_id`, `checksum`, and `application_mode` in
`public.myota_schema_migration`. The NestJS checkout's `tools/db-migrate.ts`
uses `owner`, `migration`, and `checksum` in that table. It cannot currently
run against a database restored from the Python deployment because the ledger
schemas differ.

The following baseline SQL files are byte-identical between the two
checkouts:

- Core `001_core_baseline.sql`, `002_identity_auth_support.sql`, and
  `003_identity_auth_backfill.sql`.
- Activity `001_activity_baseline.sql`.
- Geodata `001_geodata_baseline.sql`.

The NestJS checkout adds Core migrations `004` through `011`, Activity
migrations `002` through `005`, and Geodata migrations `002` and `003`. Those
forward migrations must be applied once to the transferred data, in each
owning database. In particular, Core migrations move Programme records and
catalogues out of the legacy JSON snapshot, while Identity's legacy snapshot
remains archived.

## Required transfer workflow

1. Pin both repository commits and record each source database's migration
   ledger, schema version, database name, and row counts for owner tables.
2. Stop Python APIs, workers, scheduled importers, and other writers. Confirm
   queued work and outbox state, and keep the source databases read-only for
   the full transfer window. A three-database copy is not globally atomic.
3. Create and checksum a backup of all three source databases. Keep a separate
   backup of each destination before any restore.
4. Verify the three source and three destination URLs resolve to six distinct
   database targets. Verify required PostgreSQL extensions and cluster roles,
   including Geodata's PostGIS and QGIS roles, on the destination cluster.
5. Restore each source owner into its matching destination without changing
   owner boundaries. After the restored destination passes preflight, convert
   its verified Python ledger with the owner-scoped adoption command. For
   example:

   ```sh
   MYOTA_TRANSFER_LEDGER_CONFIRM='ADOPT PYTHON LEDGER core=target-host:5432/myota_core' \
     npm run db:transfer:adopt-ledger -- --owner=core
   ```

   The command accepts only the known Python migration IDs and checksums. It
   changes ledger metadata, not application rows. Reject unknown migration
   IDs, checksum drift, or a source schema outside the verified history.

6. Apply the NestJS forward migrations with the owner-scoped migration runner.
   A failure in one database stops cutover; restore all three destinations to
   their pre-transfer backups before retrying the transfer.
7. Compare source and destination counts and domain invariants for each owner.
   Validate Core Identity and Programme reads, Activity aggregates and jobs,
   and Geodata geometry validity, entity links, import state, and PostGIS
   indexes. Record exceptions with owner and table names.
8. Copy or verify object-store objects separately and preserve their keys.
   Reconcile NATS streams and pending work separately; database transfer does
   not move JetStream messages.
9. Start NestJS writers only after all three owners and external data are
   qualified. Keep Python writers stopped. Define rollback before cutover:
   after NestJS accepts writes, switching back to the frozen Python databases
   would lose those writes unless a reverse transfer or write reconciliation
   has been completed.

## Implementation gates

The transfer tooling still needs the target restore/apply command, a
target-specific destructive confirmation, and per-owner validation reports.
The ledger adoption command and dump staging are implemented but have not been
rehearsed against disposable PostgreSQL databases. The restore command must
verify all six dump checksums before modifying any target and must apply all
NestJS migrations only after all three source schemas have been restored.

Do not run a production transfer until the tool has been rehearsed on
disposable copies of all three databases, destination role and grant handling
is verified, validation reports match the source, and rollback has been
rehearsed. The current database backup and restore tools remain useful for
same-schema recovery and are not a substitute for this workflow.
