# Database backup and restore

The commands operate on exactly three owner databases: Core, Activity, and
Geodata. Set `CORE_DATABASE_URL`, `ACTIVITY_DATABASE_URL`, and `GEO_DATABASE_URL`
to the intended PostgreSQL targets. Backup and restore refuse URLs that specify
the same normalized host, port, and database name.

Create a backup directory containing one PostgreSQL custom-format dump per
owner plus a SHA-256 manifest:

```sh
npm run db:backup -- ./backups
```

The command requires PostgreSQL 16 client tools. Set `PG_DUMP_PATH` if
`pg_dump` is not on `PATH`.

Restore all three databases from one backup directory:

```sh
MYOTA_RESTORE_CONFIRM="RESTORE myota-20261020T120000000Z" \
  npm run db:restore -- ./backups/myota-20261020T120000000Z
```

Replace the example directory with the exact backup directory name. Before
writing, restore verifies the manifest, each dump checksum, archive readability,
database names, and distinct owner targets. It requires PostgreSQL 16 client
tools; set `PG_RESTORE_PATH` if needed. Each database restore uses one
transaction, but the three-database restore is not atomic as a whole: if a later
owner fails, earlier databases remain restored. The commands back up database
state only; object-store data and JetStream messages require separate recovery
procedures. Cross-version transfer from the Python schema is tracked in
[cross-version database transfer](cross-version-data-transfer.md).
