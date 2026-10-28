# Rancher test-release values

This Fleet bundle provisions a dedicated test chart repository and operation
identity. The protected `testing` branch contains the non-secret Helm overrides
in `values.yaml`. A separate protected workflow reads those reviewed values,
publishes an immutable testing chart, and invokes Rancher's catalog upgrade
action; it does not run `helm upgrade` directly. Fleet does not manage the
catalog `App`, because Rancher owns that object as part of the Helm release.
The protected workflow can recreate missing App metadata by running the
ClusterRepo upgrade action and verifies that the App returns at the new chart
revision before accepting the rollout.

The values file was seeded from the current release's non-secret overrides and
references Kubernetes Secrets by name and key; no secret payload belongs in
this bundle. The workflow applies the exact values from the reviewed commit as
part of the catalog upgrade.

Image updates must use immutable digests. Review and merge each values change
through a pull request to `testing`; Fleet must target only the Rancher `local`
cluster and the `myota-test` namespace. Check Fleet bundle readiness, the
Rancher App status, Helm revision, pod readiness, and health endpoints after
the catalog workflow completes. A failed sync must be resolved before
accepting the deployment.

The `myota-next-testing` ClusterRepo reads only the `/testing` chart index and
runs chart operations as `myota-test-catalog-upgrader` in the explicitly set
`myota-test` namespace. Its Kubernetes Role is confined to that namespace and
the resources required by this chart, including namespaced `get`, `list`,
`watch`, `create`, `update`, `patch`, and `delete` access to Prometheus Operator
ServiceMonitors. The release workflow uses a separate
Rancher API user whose custom GlobalRole grants access only to the
`myota-next-testing` ClusterRepo and read-only qualification data in
`myota-test`.

Keep the generated local credentials in the ignored
`runtime-secrets/myota-test-secrets.yaml` file and copy only the API token to
the repository's `myota-test` Actions environment secret
`MYOTA_TEST_RANCHER_TOKEN`. The environment accepts deployments from `testing`
and blocks administrator bypass. Never use the Rancher bootstrap token, a
cluster-admin token, or a cluster-admin kubeconfig in Actions. Rotate the
time-limited API token before it expires. The workflow publishes chart versions
`1.1.6-testing.<commit-sha>.1`, then asks Rancher's catalog API to upgrade the
release and checks the chart revision and ready immutable-digest Deployments.

After a successful `Publish changed testing images` run, download its
`myota-test-image-digests-<commit-sha>` artifact. From an up-to-date `testing`
checkout, prepare a deployment proposal with:

```sh
gh run download <run-id> --name myota-test-image-digests-<commit-sha> \
  --dir /tmp/myota-test-image-digests
git switch -c deploy/myota-test-image-digests-<commit-sha>
node tools/update-myota-test-image-digests.mjs \
  deploy/fleet/myota-test/values.yaml \
  /tmp/myota-test-image-digests/myota-test-image-digests.tsv \
  <full-source-commit-sha>
git diff --check
git diff -- deploy/fleet/myota-test/values.yaml
```

Open a pull request to `testing` with the proposed values. Reviewers should
confirm that only built images were changed and that each image reference is a
sha256 digest. The `postgres`, `postgis`, and `nats` artifacts belong to the
separate infrastructure releases and are not applied through this App bundle.

### Helm-managed workload fields

Rancher applies this release with server-side apply. Do not use `kubectl patch`
or `kubectl set env` to change fields on its Deployments, including
`OBSERVE_APP_KEY`, `OBSERVE_APP_SECRET`, or `OBSERVE_ENDPOINT`. A direct patch
can take field ownership away from Helm and make the next catalog upgrade
conflict. Put test or release configuration in the chart values and deliver it
through the reviewed digest-sync pull request, then use the protected Rancher
upgrade workflow.
