# MyOTA test namespace and missing-Secret recovery

## Incident and corrected state: 2026-11-05

Loki showed 1,670 K3s error entries for missing `default/myota-auth` and
1,660 for missing `default/myota-database-urls` in a one-hour sample. These
were repeated attempts to start six Pods owned by two obsolete Deployments:
`default/myota-test-gateway` and `default/myota-test-identity`.

The actual release in `myota-test` was healthy. Its Secrets already existed
with the required keys. There was no MyOTA Helm release record or MyOTA Service
in `default`; the obsolete Deployments had Helm-style labels but no Helm release
ownership annotations. Their creation timestamp was 2026-10-28. The available
metadata does not establish which command originally created them.

The correction removed only those two orphan Deployments and their dependent
ReplicaSets/Pods. No Secrets were copied, generated or rotated; no healthy
application, infrastructure release or persistent data was removed. Private
rollback manifests were saved on the node before deletion. The working
`myota-test` namespace remained untouched.

Post-cleanup checks found no remaining MyOTA Deployments, ReplicaSets or Pods
in `default`. All previously Running `myota-test` Pods retained their UIDs and
container IDs, public `/readyz` returned HTTP 200, and the following two-minute
K3s log window contained no missing-Secret errors for either Secret. Both test
values files passed Helm lint/render validation, all rendered resources had
the expected explicit namespace, incorrect namespaces were rejected, and
another release/namespace pair remained supported.

## Deployment rules

- Release: `myota-test`; namespace: `myota-test`; Rancher cluster: `local`.
- Use the protected/reviewed testing catalog workflow documented in
  `deploy/fleet/myota-test/README.md`. Inspect the live Fleet GitRepo's revision
  and paths before changes; do not assume its source branch is `testing`.
- The chart rejects rendering release `myota-test` in any other namespace.
  Namespaced resources explicitly carry `.Release.Namespace`, including hooks.
  CI verifies namespace preservation and rejects two incorrect namespaces.
- `helm template` does not install anything. If applying approved rendered
  manifests for a documented recovery, always render **and** apply with
  `--namespace myota-test`. Prefer the catalog workflow for normal releases.
- Never resolve a wrong-namespace error by copying production/test credentials
  into `default`. Never commit Secret payloads or rendered Secret manifests.

## Diagnose before changing anything

```sh
kubectl get pods,deployments,services -n default
kubectl get pods,deployments,services -n myota-test
kubectl get gitrepo -n fleet-local myota-next-test -o yaml
helm list --namespace default --all
helm list --namespace myota-test --all
kubectl get secrets -n myota-test myota-auth myota-database-urls
```

Use a private kubeconfig if Helm cannot use kubectl's default credentials.
Compare namespace, image, labels, ownership annotations and release records.
Helm-style labels alone do not establish ownership. Inspect `secretKeyRef`,
`envFrom.secretRef`, init containers and Secret volumes; Secret names are scoped
to the Pod namespace. List only Secret names/key names, never values.

`myota-auth` requires `signing-key` and `email-service-client-secret` for the
affected services; bootstrap keys are optional. `myota-database-urls` requires
`core-database-url`, `activity-database-url` and `geo-database-url` for the full
stack. Other enabled components have additional prerequisites: use the chart
README and the actual rendered Pod specifications as the complete contract.

If a required Secret really is absent from **myota-test**, restore it from the
approved credential store/private backup into that namespace, preserving its
existing identity and database targets. Do not invent replacement database
credentials or rotate signing keys as a workaround. Wait for kubelet retries,
then check readiness and health; a rollout is not automatically required.

## Remove confirmed orphan copies

Only after confirming the correct release is healthy and these resources have
no legitimate owner or traffic, save their manifests privately (mode 0600),
record healthy Pod UIDs/container IDs, and run:

```sh
kubectl delete deployment --namespace default \
  myota-test-gateway myota-test-identity --wait=true
kubectl get deployments,replicasets,pods --namespace default \
  -l app.kubernetes.io/instance=myota-test
```

Delete the Deployments rather than only their Pods, because controllers would
recreate the Pods. Do not use a cluster-wide label deletion, Helm uninstall in
the working namespace, or blanket namespace deletion. If an active source owns
the incorrect resources, correct it first so reconciliation cannot recreate
them. Do not edit live Fleet-generated resources to hide the source error.

## Verification

1. Confirm the two Deployments, their ReplicaSets and all six failing Pods are
   gone from `default`, and remain absent after Fleet reconciliation.
2. Confirm running Pods in `myota-test` retain their UIDs/container IDs and
   remain Ready; verify normal ingress/API health endpoints.
3. Query **new** K3s/Loki entries after cleanup for `myota-auth` and
   `myota-database-urls` missing-Secret errors. Historical entries remain until
   retention expires. Observe for at least several retry intervals.
4. Run Helm lint/render checks and the wrong-namespace rejection checks before
   merging the chart guard through a pull request to `testing`. The next normal
   catalog release must use the guarded chart; do not redeploy applications
   solely to clear these orphan errors.
