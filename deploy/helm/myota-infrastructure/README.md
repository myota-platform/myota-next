# Optional three-database infrastructure

This chart creates exactly three single-instance PostgreSQL StatefulSets:
Core (`myota_core`), Activity (`myota_activity`), and Geodata (`myota_geo`,
with PostGIS). Email delivery remains in Core. It creates no fourth database.

It can also provision an isolated SeaweedFS S3-compatible endpoint by setting
`objectStorage.enabled=true`. That option requires two Kubernetes Secrets:
`myota-object-storage` with `access-key`, `secret-key`,
`profile-image-access-key`, and `profile-image-secret-key`; and
`myota-seaweedfs-s3-config` with the generated `s3.json` key. The latter is
created from `tools/render-seaweedfs-s3-config.ts`. The chart creates the
standard MyOTA buckets after SeaweedFS becomes ready.

The chart is optional. Use it for a small single-cluster deployment or point
the NestJS chart at externally managed database services instead. The
StatefulSets are not replicated and do not provide high availability or
backups. Configure persistent-volume sizes and storage class for the actual
dataset, and take verified off-cluster backups before production use.

## Credentials

Before installation, create `myota-postgres-auth` (or set
`postgresSecret` in values) with these Secret keys:

- `username`: PostgreSQL owner and migration role name; use `myota_admin`.
- `password`: password for the owner and migration role.
- `app-password`: password for the restricted runtime role `myota_app`.

The init script creates the runtime role on first initialization of each empty
volume and grants it access to that database's public schema. It does not
modify credentials or roles on an existing volume. Do not reuse an existing
volume with different role credentials without a reviewed recovery procedure.

Create the app chart's `myota-database-urls` and
`myota-database-migration-urls` Secrets using URLs that point to the three
services from this release. For example, if the infrastructure release is
`myota-data`:

```text
postgresql://myota_app:<url-encoded-app-password>@myota-data-core-postgres:5432/myota_core
postgresql://myota_app:<url-encoded-app-password>@myota-data-activity-postgres:5432/myota_activity
postgresql://myota_app:<url-encoded-app-password>@myota-data-geo-postgres:5432/myota_geo
```

Use `myota_admin` and the owner password in the migration URLs. Keep these
Secrets separate from Helm values and URL-encode credential characters.

## Install order

Install this release first and wait for all three StatefulSets to become Ready.
Then install or upgrade the NestJS app chart, whose migration Job runs before
its APIs and workers. This ordering lets the migration gate reach the databases
before the application release begins.

```sh
helm upgrade --install myota-data deploy/helm/myota-infrastructure \
  --namespace myota --create-namespace \
  -f values-production.yaml

helm upgrade --install myota-next deploy/helm/myota-next \
  --namespace myota -f values-production.yaml
```

StatefulSet PVCs use Kubernetes' default `Retain` behavior when the StatefulSet
is removed or scaled down. Uninstalling the chart does not remove the stored
data. Record database names, PVCs, and credentials in the backup/restore
procedure before using it for production data.
