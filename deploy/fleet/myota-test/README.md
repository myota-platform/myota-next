# Rancher test-release values

This raw Fleet bundle owns the declarative `spec.values` for Rancher's existing
`myota-test` catalog App. Rancher remains the controller that upgrades the
catalog chart; Fleet reconciles the values from the protected `testing` branch.

The manifest intentionally contains only `spec.values`. It preserves the live
App's chart reference, release metadata, and ownership fields. Values were
seeded from the current release's non-secret overrides and reference
Kubernetes Secrets by name and key; no secret payload belongs in this bundle.

Image updates must use immutable digests. Review and merge each values change
through a pull request to `testing`; Fleet must target only the Rancher `local`
cluster and the `myota-test` namespace. Check Fleet bundle readiness, the
Rancher App status, Helm revision, pod readiness, and health endpoints after
reconciliation. A failed sync must be resolved before accepting the deployment.

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
