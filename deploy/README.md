# Local runtime

The Compose stack starts the NestJS APIs, workers, browser apps, and their
shared infrastructure for local development. It keeps exactly three database
owners: Core PostgreSQL, Activity PostgreSQL, and Geodata PostGIS. Email delivery
uses Core PostgreSQL.

Copy the development environment file, then build and start from the repository
root:

```sh
cp deploy/.env.example deploy/.env
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build
```

Set `MYOTA_BOOTSTRAP_ADMIN_EMAIL` and `MYOTA_BOOTSTRAP_ADMIN_PASSWORD` in
`deploy/.env` before startup. Identity creates that administrator on first
startup and does not replace a password once one exists.

The stack applies the checked-in database migrations and provisions finite,
development-sized JetStream limits from `deploy/.env`. Those settings are
local examples, not production capacity recommendations. The provisioner
requires `NATS_TOPOLOGY_APPLY=1`, creates missing resources, and stops on
configuration drift. See [JetStream topology](jetstream/README.md).

Open the Participant app at `http://localhost:8090`, Admin at
`http://localhost:8091`, the Gateway at `http://localhost:8080`, Mailpit at
`http://localhost:8025`, and SeaweedFS S3 at `http://localhost:8333`. Mailpit uses a
self-signed STARTTLS certificate generated in a local-only volume. The email
worker trusts that local certificate; do not reuse these credentials or
certificates outside development.

Compose publishes database, NATS, and object-store ports only on loopback.
Persistent local data lives in Docker volumes. Remove those volumes only when
you intend to delete the local databases, messages, and uploaded objects:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml down -v
```

This Compose file is a development environment. Production image publication,
immutable image pinning, data transfer, backups, restore, and rollout
qualification remain separate work.

The initial NestJS [Helm chart](helm/myota-next/README.md) deploys the APIs and
background processes against external PostgreSQL, NATS, and S3-compatible
services. Its opt-in JetStream Job provisions reviewed stream topology but does
not install a NATS server. The chart does not provision the other stateful
infrastructure or replace the prior Fleet release process, and is not qualified
for production rollout.
