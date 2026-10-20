# Cross-version database transfer

This document records verified migration inputs and the work needed to transfer
the running Python platform into the NestJS monorepo. A read-only preflight
command checks source migration history and all six database targets. The
transfer workflow stages source and destination dumps, restores the three
source databases into empty NestJS destinations, adopts the verified migration
ledgers, and applies NestJS forward migrations. Data-level parity validation
and a disposable-database rehearsal remain outstanding.

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
migration-ledger shape and non-extension application object counts. It does
not modify either side.

Stage source dumps and destination recovery dumps in a new private directory:

```sh
MYOTA_TRANSFER_SOURCE_FROZEN=YES \
  npm run db:transfer:stage -- --archive-dir=./backups/myota-transfer-20261020
```

Set `MYOTA_TRANSFER_SOURCE_FROZEN=YES` after stopping all Python APIs, workers,
scheduled importers, and other writers before staging. The command runs
preflight again, writes six PostgreSQL custom-format dumps and a SHA-256
manifest containing the preflight report, and verifies each archive is
readable. It refuses an existing output directory. The files contain database
data; protect and retain them as sensitive backups. Staging does not restore
or modify a database.

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
   queued work and outbox state. Keep the source databases read-only from
   staging through cutover. A three-database copy is not globally atomic.
3. Run `db:transfer:preflight`, then `db:transfer:stage` as documented above.
   Staging backs up all three source databases and all three destinations,
   validates checksums and archive readability, and records the preflight
   result.
4. Stop any NestJS writers and ensure each destination has no non-extension
   application objects. The apply command checks this condition and refuses a
   destination with application schema objects or data. It also requires a
   separate target confirmation naming each destination host, port, and
   database:

   ```sh
   MYOTA_TRANSFER_SOURCE_FROZEN=YES \
   MYOTA_TRANSFER_TARGET_OFFLINE=YES \
   MYOTA_TRANSFER_CONFIRM='TRANSFER core=core-host:5432/myota_core activity=activity-host:5432/myota_activity geo=geo-host:5432/myota_geo' \
     npm run db:transfer:apply -- --archive-dir=./backups/myota-transfer-20261020
   ```

   Apply verifies all staged checksums and endpoints, creates fresh recovery
   dumps for the three destinations, restores all source databases, converts
   the verified Python migration ledgers, and applies the NestJS owner
   migrations. It records progress in `apply-report.json`. Its completion
   status is `migration-complete-validation-required`; this does not establish
   data-level parity.

5. If apply fails after restore begins, do not start any writers. Recreate the
   three destinations, then restore their pre-apply recovery dumps with:

   ```sh
   MYOTA_RESTORE_CONFIRM='RESTORE recovery-before-apply' \
     npm run db:restore -- ./backups/myota-transfer-20261020/recovery-before-apply
   ```

   The recovery manifest uses the existing `db:restore` format. Recreating the
   destinations removes objects from a partial source restore before recovery.

6. Compare source and destination counts and domain invariants for each owner.
   Validate Core Identity and Programme reads, Activity aggregates and jobs,
   and Geodata geometry validity, entity links, import state, and PostGIS
   indexes. Record exceptions with owner and table names.
7. Copy or verify object-store objects separately and preserve their keys.
   Reconcile NATS streams and pending work separately; database transfer does
   not move JetStream messages.
8. Start NestJS writers only after all three owners and external data are
   qualified. Keep Python writers stopped. Define rollback before cutover:
   after NestJS accepts writes, switching back to the frozen Python databases
   would lose those writes unless a reverse transfer or write reconciliation
   has been completed.

## Implementation gates

The restore/apply command, ledger adoption, and dump staging are implemented.
The workflow has not been rehearsed against disposable PostgreSQL databases,
and per-owner data validation reports are not implemented. The apply command
does not move object-store data or JetStream messages.

Do not run a production transfer until the tool has been rehearsed on
disposable copies of all three databases, destination role and grant handling
is verified, validation reports match the source, and rollback has been
rehearsed. The current database backup and restore tools remain useful for
same-schema recovery and are not a substitute for this workflow.
