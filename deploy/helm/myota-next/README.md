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
- `secrets`, `dependencies`, `migrations`, `observe`, and
  `jetstreamProvisioner` configure secret references, external endpoints,
  schema setup, Observe reporting, and NATS topology provisioning.
- Pod-level values control image pull secrets, annotations/labels, security
  contexts, scheduling, topology spread, rollout strategy, and probes.
- `commonResources` sets default CPU and memory requests/limits; a component
  may override them with its own `resources` value.

Use `values-testing.yaml` as the non-secret reference configuration for the
current K3s testing deployment. Keep credentials in Kubernetes Secrets, never
in chart values or release artifacts.

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
images without publishing. Use the digest printed in the workflow summary for
deployment values.

Create Kubernetes Secrets before installation:

- `myota-database-urls`: `core-database-url`, `activity-database-url`,
  `geo-database-url`.
- `myota-database-migration-urls`: the same keys with migration credentials.
- `myota-auth`: `signing-key`, `email-service-client-secret`; optionally
  `bootstrap-email` and `bootstrap-password` for initial Identity setup.
- `myota-object-storage`: `access-key`, `secret-key`,
  `profile-image-access-key`, `profile-image-secret-key`.
- `myota-smtp`: `password` when enabling `email-worker`.
- `myota-nats-credentials`: `url`, the configured NATS connection URL,
  including credentials when authentication is enabled.
- `myota-observe`: `app-key` and `app-secret` when enabling Observe reporting.

Database URLs must point to three distinct databases. Core is shared by
Identity and Programmes; Activity and Geodata have their own URLs. Use runtime
database credentials for services and migration credentials for the migration
Job where permissions differ. Keep all credentials in Secrets, not Helm values.

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
initial chart version is `1.0.0`; the release workflow keeps each `.tgz` and
updates `index.yaml` on GitHub Pages for every published GitHub Release. Each
subsequent GitHub release increments the chart patch version, while `appVersion`
records the GitHub release tag used to package the chart.

To add the repository with Helm:

```sh
helm repo add myota https://myota-platform.github.io/myota-next
helm repo update
helm search repo myota/myota-next --versions
```

The workflow has a manual dispatch input for bootstrapping the first chart
from the current repository branch. Subsequent chart versions are published
automatically when a GitHub Release is published.

The app chart emits a Traefik `IngressRoute` (`traefik.io/v1alpha1`) rather
than a generic Ingress, matching this K3s server's `websecure` entry point and
`acmeresolver`. Set `ingress.apiHost`, `ingress.adminHost`,
`ingress.participantHost`, and optionally `ingress.objectStorageHost` for the
four public endpoints.

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
`components.geodata.legacyConcurrency.upload` sets the per-process limit for
multipart upload finalization in the Geodata API.

Workers expose internal health listeners only where their process supports
them. The chart creates ClusterIP services for the four domain APIs and the
Gateway; worker health ports are not exposed as Services.

This is the initial Kubernetes deployment source for the NestJS monorepo. It
does not yet reproduce the previous deployment's stateful infrastructure,
retention schedules, autoscaling, dashboards, alerts, or Fleet release
automation. Those remain explicit deployment work before production rollout.
