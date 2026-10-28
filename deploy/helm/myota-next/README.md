# MyOTA NestJS chart

This chart deploys the NestJS APIs, background processes, Admin app, and
Participant app from this monorepo. It keeps Core, Activity, and Geodata as
three separately configured PostgreSQL owners. It does not provision
databases, a NATS server, or object storage. Configure those services
independently. An opt-in Job can provision the registered streams and durable
consumers on the configured NATS server.

## Configurable values

`values.yaml` provides the main deployment controls:

- `images` selects each component image by immutable digest or tag.
- `components` controls API and worker enablement, replica counts, ports,
  environment, resource requests/limits, and health checks.
- `ingress` configures Traefik entry points, API/Admin/Participant/S3
  hostnames, middleware references, TLS certificate resolver, and optional
  TLS Secret. The test cluster uses `websecure` with `acmeresolver`.
- `secrets`, `dependencies`, `migrations`, `observe`, `prometheus.serviceMonitor`,
  `prometheus.rules`, `prometheus.alertmanagerConfig`, and
  `jetstreamProvisioner` configure secret references, external endpoints,
  schema setup, Observe reporting, Prometheus API scraping, and NATS topology
  provisioning.
- Pod-level values control image pull secrets, annotations/labels, security
  contexts, scheduling, topology spread, rollout strategy, and probes.
- `commonResources` sets default CPU and memory requests/limits; a component
  may override them with its own `resources` value.

Use `values-testing.yaml` as the non-secret reference configuration for the
current K3s testing deployment. Keep credentials in Kubernetes Secrets, never
in chart values or release artifacts.

`observe.endpoint` optionally overrides the hosted Observe collector URL for a
configured self-hosted endpoint. The app key and secret remain in the Secret
named by `observe.secretName`; reporting and log forwarding are enabled only
when both credential keys contain non-empty values.

When the Prometheus Operator CRDs are installed, set
`prometheus.serviceMonitor.enabled: true` to scrape `/metrics` from the Gateway,
Identity, Programmes, Activity, and Geodata APIs, plus the Activity notification,
Activity, Geodata, Email, and outbox workers inside the release namespace. The
worker endpoints are exposed only through ClusterIP Services. The Activity and
Geodata worker metrics include bounded work-type outcomes and durations, plus
NATS and PostgreSQL dependency state. The ServiceMonitor stays disabled by
default. This Prometheus scrape path is complementary to `@nestjs/observe`; it
does not verify Observe telemetry delivery or log/trace correlation.

Set `prometheus.rules.enabled: true` to install release-scoped alerts for
unavailable scrape targets, API 5xx responses, worker dependency/work failures,
and unresolved dead letters. Configure `prometheus.rules.labels` to match the
installed Prometheus rule selector; this chart defaults that label to
`release: kube-prometheus-stack`. The test release enables these alerts. See the
[Prometheus alert guide](../../../docs/operations/alerts.md) for conditions and
verification.

`prometheus.alertmanagerConfig.enabled` installs an optional Prometheus
Operator `AlertmanagerConfig` for `MyOTAUnresolvedOutboxDeadLetters`. It
requires the Operator CRDs and routes only that alert to the configured email
receiver. Set `email.to`, `email.from`, and `email.smarthost`; TLS is required
by default. For a private SMTP certificate authority, set `email.caSecretName`
and `email.caSecretKey` to reference a Secret in the release namespace. The test
Fleet values route to the in-cluster SMTP sink and trust its qualification CA.
Leave this disabled unless the release namespace is authorized to define an
Alertmanager receiver.

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

Repeat the application build for every enabled Nest CLI project. The workflow
also builds the Admin and Participant images from their own Docker contexts.
Image names in `values-example.yaml` match the repository workflow. Publishing
a GitHub release builds and publishes per-image SHA and release tags after the
quality job passes. Pull requests run the quality checks and build all container
images without publishing. A successful push to `testing` publishes only the
runtime images affected by that change under both `testing` and
`testing-<commit-sha>` tags. Use the immutable digest printed in that workflow's
summary for the isolated `myota-test` rollout; production images remain tied to
GitHub releases.

Create Kubernetes Secrets before installation:

- `myota-database-urls`: `core-database-url`, `activity-database-url`,
  `geo-database-url`, each using only its owner-specific runtime role.
- `myota-database-migration-urls`: the same keys using database-owner
  credentials; this Secret is mounted only into the migration Job.
- `myota-postgres-auth`: `core-app-password`, `activity-app-password`, and
  `geo-app-password` for the runtime roles. The PostgreSQL owner `username` and
  `password` are used only by database pods; the migration Secret supplies
  admin connection URLs.
- `myota-auth`: `signing-key`, `email-service-client-secret`; optionally
  `bootstrap-email` and `bootstrap-password` for initial Identity setup.
- `myota-object-storage`: `access-key`, `secret-key`,
  `profile-image-access-key`, `profile-image-secret-key`.
- `myota-geodata-enrichment`: `api-key` for BigDataCloud reverse geocoding;
  optional until location enrichment is configured.
- `myota-smtp`: `password` when enabling `email-worker`.
- `myota-nats-credentials`: `url`, the configured NATS connection URL,
  including credentials when authentication is enabled.
- `myota-observe`: `app-key` and `app-secret` when enabling Observe reporting.

Database URLs must point to three distinct databases. Core is shared by
Identity and Programmes; Activity and Geodata have their own URLs. Use the
runtime roles `myota_core_app`, `myota_activity_app`, and `myota_geo_app` for
the corresponding URLs. Keep superuser or database-owner URLs only in the
`databaseMigrations` Secret; application Deployments receive runtime URLs only.

The migration hook synchronizes the owner-specific roles before applying SQL
migrations and refreshes their application-table privileges afterward. It reads
the corresponding passwords from the `databaseRuntimeCredentials` Secret
(default `myota-postgres-auth`) using the `core-app-password`,
`activity-app-password`, and `geo-app-password` keys. These credentials are
available only to the migration Job and the database bootstrap containers.

## Rotating credentials on initialized databases

The database init scripts run only for empty data volumes. For the existing
test databases, the migration hook safely creates the three owner-specific
roles without deleting or copying data. Use this sequence:

1. Generate three independent random passwords of at least 32 characters.
   Update the three runtime password keys in `myota-postgres-auth`, then update
   the three URLs in `myota-database-urls` to use their matching role and
   password. Keep `myota_app` enabled during this transition.
2. Upgrade the chart. Its pre-upgrade migration Job creates or updates the
   owner-specific roles, applies schema migrations using the separate
   `databaseMigrations` URLs, and refreshes runtime table grants.
3. Wait for every application Deployment and worker to become Ready. Run
   `npm run db:check-runtime-role-isolation` with the three runtime URLs in a
   controlled environment. It checks owner access and cross-owner login denial
   without reading application rows.
4. After that evidence passes, run
   `npm run db:sync-runtime-roles -- --retire-legacy` once with the three
   migration/admin URLs and the runtime password variables available. This
   disables the old shared `myota_app` role, revokes its database and object
   grants, and terminates its remaining sessions. Run the isolation check again.

Do not retire `myota_app` before the application rollout and the first
successful isolation check. The role-retirement command is intentionally
separate from the automatic migration hook to keep rollback possible.

The `geodata-worker` reads the BigDataCloud key from
`secrets.geodataEnrichment` (default Secret `myota-geodata-enrichment`, key
`api-key`). The endpoint, locality language, and timeout are non-secret values
under `geodataWorker.locationEnrichment`; defaults are
`https://api-bdc.net/data/reverse-geocode`, `en`, and 10 seconds. The key is
optional so deployments without a provider credential remain available and
record enrichment as `NOT_CONFIGURED`. Use a provider plan that permits
server-side lookups of stored entity coordinates. Keep the key out of chart
values and Git. See the [location enrichment operations guide](../../../docs/operations/location-enrichment.md)
for safe provisioning, rotation, and qualification steps.

For the optional single-instance PostgreSQL StatefulSets, install
[`myota-infrastructure`](../myota-infrastructure/README.md) first and wait for
Core, Activity, and Geodata to become Ready. Configure the database URL Secrets
to use that release's three service names, then install this chart. NATS and
S3-compatible storage remain external prerequisites.

Configure repository and tag or digest for each enabled component image and
`migrations.image`, then install with environment-specific non-secret values:

```sh
helm upgrade --install myota-next deploy/helm/myota-next \
  --namespace myota-test --create-namespace -f values-testing.yaml
```

## Rancher catalog and versioning

The public chart repository is
`https://myota-platform.github.io/myota-next`. Add it as a Rancher Cluster
Repository / Helm repository to make the chart visible under Applications. The
first public chart version is `1.1.0`; the release workflow keeps each `.tgz`
and updates `index.yaml` on GitHub Pages for every published GitHub Release. A
release tag such as `v1.1.0` determines the chart's semantic version (`1.1.0`),
while `appVersion` records the full GitHub release tag.

To add the repository with Helm:

```sh
helm repo add myota https://myota-platform.github.io/myota-next
helm repo update
helm search repo myota/myota-next --versions
```

The workflow has a manual dispatch input for publishing a tagged release chart.
Subsequent chart versions are published automatically when a GitHub Release is
published.

The app chart emits a Traefik `IngressRoute` (`traefik.io/v1alpha1`) rather
than a generic Ingress, matching this K3s server's `websecure` entry point and
`acmeresolver`. Set `ingress.apiHost`, `ingress.adminHost`,
`ingress.participantHost`, and optionally `ingress.objectStorageHost` for the
four public endpoints.

On the Participant hostname, Traefik routes `/v1/` requests to Gateway and
serves all other paths from the Participant web application. This keeps the
browser API calls same-origin while preserving the separate web and API
processes.

`migrations.enabled` runs the checked-in owner migrations as a Helm
pre-install/pre-upgrade Job against all three databases. The Job is a release
gate; review migration compatibility with currently running versions before
using rolling upgrades. The chart does not migrate data from the Python
deployment.

The JetStream provisioner is disabled by default. Enable it only after
reviewing stream topology and measured capacity, set
`jetstreamProvisioner.confirmedCapacityReview=true`, and provide positive
finite values for every `jetstreamProvisioner.capacity` field. The Job uses the
same create-only, drift-rejecting tool as local provisioning and never updates
existing stream or consumer configuration. See
[`deploy/jetstream/README.md`](../../jetstream/README.md) for required limits.

Geodata durable concurrency can be configured independently with
`geodataWorker.maxAckPending.preprocessing`, `.promotion`, `.deletion`, and
`.enrichment`. The chart passes these values to both the Geodata worker and the
JetStream provisioner Job, so runtime polling concurrency matches each
consumer's `max_ack_pending`. If provisioning is managed outside this chart,
apply the same settings there. Existing consumer configuration is immutable in
the provisioner; changing a policy requires an explicitly reviewed successor
durable.
The legacy aggregate import limit can be set with
`geodataWorker.legacyConcurrency.import`; it applies across preprocessing and
promotion when native import concurrency settings are absent.
`geodataWorker.importMaxAttempts` controls how many times an import run may be
claimed before a processing failure makes it terminal. The default is `10`,
allowing recovery from short object-store restarts while preserving a finite
failure limit.
`components.geodata.legacyConcurrency.upload` sets the per-process limit for
multipart upload finalization in the Geodata API.

Workers expose internal health listeners only where their process supports
them. The chart creates ClusterIP services for the four domain APIs and the
Gateway; worker health ports are not exposed as Services.

This is the initial Kubernetes deployment source for the NestJS monorepo. It
does not yet reproduce the previous deployment's stateful infrastructure,
retention schedules, autoscaling, dashboards, alerts, or Fleet release
automation. Those remain explicit deployment work before production rollout.
