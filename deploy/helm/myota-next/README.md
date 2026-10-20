# MyOTA NestJS chart

This chart deploys the NestJS APIs and background processes from this
monorepo. It keeps Core, Activity, and Geodata as three separately configured
PostgreSQL owners. It does not provision databases, NATS, or object storage;
configure those services independently and provide their connection settings.

## Images and install

Build and publish a per-application image with the root `Dockerfile`. Configure
each entry under `images` with that image's repository and either a tag or an
immutable digest. `outbox-core`, `outbox-activity`, and `outbox-geodata` share
the `outbox-worker` image and run with separate owner settings.

```sh
docker build --build-arg APP_NAME=identity \
  -t ghcr.io/myota-platform/myota-next-identity:VERSION .
docker build -f deploy/Dockerfile.tools \
  -t ghcr.io/myota-platform/myota-next-tools:VERSION .
```

Repeat the application build for every enabled Nest CLI project. The image
names in `values-example.yaml` illustrate a naming convention; no publication
workflow is included yet. Prefer digests in production values.

Create Kubernetes Secrets before installation:

- `myota-database-urls`: `core-database-url`, `activity-database-url`,
  `geo-database-url`.
- `myota-database-migration-urls`: the same keys with migration credentials.
- `myota-auth`: `signing-key`, `email-service-client-secret`; optionally
  `bootstrap-email` and `bootstrap-password` for initial Identity setup.
- `myota-object-storage`: `access-key`, `secret-key`,
  `profile-image-access-key`, `profile-image-secret-key`.
- `myota-smtp`: `password` when enabling `email-worker`.
- `myota-observe`: `app-key` and `app-secret` when enabling Observe reporting.

Database URLs must point to three distinct databases. Core is shared by
Identity and Programmes; Activity and Geodata have their own URLs. Use runtime
database credentials for services and migration credentials for the migration
Job where permissions differ. Keep all credentials in Secrets, not Helm values.

Configure repository and tag or digest for each enabled component image and
`migrations.image`, then install with environment-specific non-secret values:

```sh
helm upgrade --install myota-next deploy/helm/myota-next \
  --namespace myota --create-namespace -f values-production.yaml
```

`migrations.enabled` runs the checked-in owner migrations as a Helm
pre-install/pre-upgrade Job against all three databases. The Job is a release
gate; review migration compatibility with currently running versions before
using rolling upgrades. The chart does not migrate data from the Python
deployment.

Workers expose internal health listeners only where their process supports
them. The chart creates ClusterIP services for the four domain APIs and the
Gateway; worker health ports are not exposed as Services.

This is the initial Kubernetes deployment source for the NestJS monorepo. It
does not yet reproduce the previous deployment's stateful infrastructure,
JetStream provisioning, retention schedules, autoscaling, dashboards, alerts,
or Fleet release automation. Those remain explicit deployment work before
production rollout.
