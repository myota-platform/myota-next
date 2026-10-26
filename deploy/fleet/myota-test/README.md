# Rancher test-release values

This Fleet bundle owns the desired values for Rancher's `myota-test` catalog
App and provisions a dedicated test chart repository and operation identity.
Fleet reconciles the App values from the protected `testing` branch. A separate
protected workflow publishes an immutable testing chart and invokes Rancher's
catalog upgrade action for that chart; it does not run `helm upgrade` directly.

The manifest intentionally contains only `spec.values`. It preserves the live
App's chart reference, release metadata, and owner reference. Values were
seeded from the current release's non-secret overrides and reference
Kubernetes Secrets by name and key; no secret payload belongs in this bundle.

Image updates must use immutable digests. Review and merge each values change
through a pull request to `testing`; Fleet must target only the Rancher `local`
cluster and the `myota-test` namespace. Check Fleet bundle readiness, the
Rancher App status, Helm revision, pod readiness, and health endpoints after
reconciliation. A failed sync must be resolved before accepting the deployment.

The `myota-next-testing` ClusterRepo reads only the `/testing` chart index and
runs chart operations as `myota-test-catalog-upgrader` in the explicitly set
`myota-test` namespace. Its Kubernetes Role is confined to that namespace and
the resources required by this chart. The release workflow uses a separate
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
  deploy/fleet/myota-test/app.yaml \
  /tmp/myota-test-image-digests/myota-test-image-digests.tsv \
  <full-source-commit-sha>
git diff --check
git diff -- deploy/fleet/myota-test/app.yaml
```

Open a pull request to `testing` with the proposed values. Reviewers should
confirm that only built images were changed and that each image reference is a
sha256 digest. The `postgres`, `postgis`, and `nats` artifacts belong to the
separate infrastructure releases and are not applied through this App bundle.
