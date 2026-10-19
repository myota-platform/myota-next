# Database migration baseline

The numbered SQL files here are copied as schema and data-migration
compatibility references from MyOTA commit
`7f904a5130e59006765cf882956a4adbfecb17ec`. They preserve three independent
targets:

- `core/` — Core PostgreSQL for Identity and Programmes.
- `activity/` — Activity PostgreSQL for activations, QSOs, awards, and jobs.
- `geo/` — Geodata PostgreSQL with PostGIS for spatial data and imports.

This is a starting baseline, not yet the migration strategy for an eventual
data transition. Before cutover, define forward migrations, validate source and
target counts and constraints, test repeatable transfer on disposable copies,
and document rollback for each database independently. Do not introduce
cross-database foreign keys or combine the three restore boundaries.
