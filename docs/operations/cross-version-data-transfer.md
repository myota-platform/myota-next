# Cross-version database transfer

**Out of scope for the current MyOTA parity goal.** The target platform starts
with empty databases; this document is retained as historical planning
material and is not a required implementation or deployment gate.

This document records verified migration inputs and the work needed to transfer
the running Python platform into the NestJS monorepo. A read-only preflight
command checks the three application database owners and the legacy Email
database. The transfer stages four source dumps and three destination recovery
dumps, restores the three owner databases, merges legacy Email data into Core,
adopts the verified migration ledgers, and applies NestJS forward migrations.
CI rehearses the complete command sequence against disposable source and
destination databases with Identity, Programme, Activity, Geodata, and legacy
Email fixture data. Production-sized rehearsal, ACL and grant review, object-store
and NATS reconciliation, and full parity sign-off remain outstanding.

Set `LEGACY_CORE_DATABASE_URL`, `LEGACY_ACTIVITY_DATABASE_URL`,
`LEGACY_GEO_DATABASE_URL`, and `LEGACY_EMAIL_DATABASE_URL` to the frozen
Python source databases. Set `CORE_DATABASE_URL`, `ACTIVITY_DATABASE_URL`, and
`GEO_DATABASE_URL` to the three NestJS destinations. The legacy email database
is merged into Core; the target remains exactly three owner databases. Then
run:

```sh
npm run db:transfer:preflight
```

The command makes read-only PostgreSQL connections. It requires seven
distinct host/port/database endpoints, verifies the source migration ledger and
known checksums for each of the three owners, checks that source ACL roles
exist on the matching destination, verifies that the Geodata destination
provides each required extension at the source version, and reports
destination migration-ledger shape and non-extension application object
counts. It also checks the legacy email database against the pinned email
schema, confirms its four delivery tables are absent from legacy Core, and
reports their row counts. It does not modify either side.

Stage source dumps and destination recovery dumps in a new private directory:

```sh
MYOTA_TRANSFER_SOURCE_FROZEN=YES \
  npm run db:transfer:stage -- --archive-dir=./backups/myota-transfer-20261020
```

Set `MYOTA_TRANSFER_SOURCE_FROZEN=YES` after stopping all Python APIs, workers,
scheduled importers, the Email worker, and other writers before staging. The
command runs preflight again, writes four source and three destination PostgreSQL
custom-format dumps, and records their SHA-256 checksums in a manifest with
the preflight report. It verifies each archive is readable and refuses an
existing output directory. The files contain database data; protect and retain
them as sensitive backups. Staging does not restore or modify a database.

## Database owners

Transfer each owner independently and keep the three destinations distinct:

| Owner    | Source contents                              | NestJS destination              |
| -------- | -------------------------------------------- | ------------------------------- |
| Core     | Identity, Programme, and Email delivery data | Core PostgreSQL                 |
| Activity | Activations, QSOs, awards, and Activity work | Activity PostgreSQL             |
| Geodata  | Entities, imports, reviews, and Geodata work | Geodata PostgreSQL with PostGIS |

Email is a legacy source database only. Its delivery ledger and audit tables
are copied into Core after the Core Email migration runs; it does not create a
fourth target database.

Application IDs and event references remain opaque across owners. The transfer
must not create cross-database foreign keys or join data across these targets.

## Verified migration history

The Python checkout uses `deploy/db/migrations/run.sh` and records
`migration_id`, `checksum`, and `application_mode` in
`public.myota_schema_migration`. The NestJS checkout's `tools/db-migrate.ts`
records `owner`, `migration`, and `checksum` in the separate
`public.myota_nest_schema_migration` table. The ledger adoption step validates
the restored Python history and copies its verified checksums into the NestJS
ledger while preserving the Python ledger for audit and validation.

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

The Python Email worker uses a separate `myota_email` source database. Its
four delivery tables use the pinned
`myota-platform/myota-email-worker@be5a4d965fb8465fd0ce3c3172bde8a0af38aec1`
schema. The migration is byte-identical to Core migration
`005_identity_email_delivery.sql`; transfer copies only its table data into
Core after that migration creates the target tables.

## Required transfer workflow

1. Pin the Python monorepo, Email worker, and NestJS monorepo commits. Record
   each source database's schema version, database name, and row counts. The
   three owner databases must also match their verified migration ledgers.
2. Stop Python APIs, workers, scheduled importers, the Email worker, and other
   writers. Confirm queued work and outbox state. Keep the source databases
   read-only from staging through cutover. Four legacy sources feed three
   target databases; transfer is not globally atomic.
3. Run `db:transfer:preflight`, then `db:transfer:stage` as documented above.
   Staging backs up all four source databases and all three destinations,
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
   dumps for the three destinations, restores Core, Activity, and Geodata,
   converts the verified Python migration ledgers, applies the NestJS owner
   migrations, and merges the legacy email delivery tables into Core in one
   transaction. It records progress in `apply-report.json`. Its completion
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

6. With all four sources frozen and the three targets offline, run the
   read-only database validation report:

   ```sh
   MYOTA_TRANSFER_SOURCE_FROZEN=YES \
   MYOTA_TRANSFER_TARGET_OFFLINE=YES \
   MYOTA_TRANSFER_VALIDATION_CONFIRM='VALIDATE core=core-host:5432/myota_core activity=activity-host:5432/myota_activity geo=geo-host:5432/myota_geo' \
     npm run db:transfer:validate -- --archive-dir=./backups/myota-transfer-20261020
   ```

   The command requires a successful apply report for the same targets. It
   compares row counts and PostgreSQL row fingerprints for preserved tables,
   checks Core Programme records, content, and policy-draft snapshot
   transformations; Identity email, callsign, and role-scope migrations;
   compares all four legacy email tables and their identity sequences against
   Core; and checks Geodata category-order, conflation-field, and validation
   note migrations alongside references, geometry, and indexes.
   It writes a private `validation-report-*.json` file in the archive. The
   fingerprints use PostgreSQL's 64-bit `hashtextextended` and require matching
   server major versions. They are a transfer check, not a cryptographic proof
   or complete parity sign-off. Review source and destination counts, domain
   reads, object-store keys and content, NATS streams and pending work, and
   record exceptions with owner and table names.

7. Copy or verify object-store objects separately and preserve their keys.
   Reconcile NATS streams and pending work separately; database transfer does
   not move JetStream messages.
8. Start NestJS writers only after all three owners and external data are
   qualified. Keep Python writers stopped. Define rollback before cutover:
   after NestJS accepts writes, switching back to the frozen Python databases
   would lose those writes unless a reverse transfer or write reconciliation
   has been completed.

## Implementation gates

The restore/apply command, ledger adoption, four-source/three-target dump
staging, Core Email data merge, and read-only per-owner database validation
report are implemented. CI runs these commands end to end with disposable
PostgreSQL databases and fixture data for Identity, Programme, Activity,
Geodata, and each legacy Email table. This qualifies archive creation and restore, ledger
adoption, forward migrations, Email data copying, sequence restoration, and
the validation report for those fixtures. CI then recreates all three targets,
adds simulated partial state, and restores the `recovery-before-apply` dumps to
verify rollback to the captured pre-apply database state. This does not qualify
production-sized rollback or recovery of writes accepted after cutover. The
workflow does not establish complete function parity or compare object-store
data and JetStream messages. The report compares known forward-migration
transformations as well as stable table rows.

Do not run a production transfer until the tool has been rehearsed on
production-sized copies of all four source databases and three target
databases, destination role and grant handling is verified, validation reports
match the source, and rollback has been rehearsed for the actual cutover plan.
The current database backup and restore tools remain useful for same-schema
recovery and are not a substitute for this workflow.
