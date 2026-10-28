# Location enrichment operations

This guide configures and verifies asynchronous reverse geocoding in the
Geodata worker. Use a test provider credential in `myota-test`; never use a
production key for qualification.

## Configuration

The Helm chart injects the optional `BIGDATACLOUD_API_KEY` only into
`geodata-worker`. Configure these non-secret chart values as needed:

- **Provider endpoint** —
  `geodataWorker.locationEnrichment.reverseGeocodeUrl`; defaults to
  `https://api-bdc.net/data/reverse-geocode`.
- **Locality language** —
  `geodataWorker.locationEnrichment.localityLanguage`; defaults to `en`.
- **Request timeout** —
  `geodataWorker.locationEnrichment.timeoutSeconds`; defaults to 10 seconds.
- **Kubernetes Secret** — `secrets.geodataEnrichment`; defaults to
  `myota-geodata-enrichment`.
- **Secret key** — `api-key`.

The endpoint, language, and timeout are non-secret Helm values. Use a
BigDataCloud account and plan that permit server-side reverse-geocoding lookups
of stored entity coordinates. Review the provider's current usage limits before
running a catalogue backfill.

Without the Secret, the Geodata worker stays available and enrichment reports
`NOT_CONFIGURED`. Do not put the API key in a values file, command history,
ConfigMap, image, log, or Git repository.

## Create or rotate the Kubernetes Secret

Set the namespace and release name for the intended environment. Run this in a
private terminal; the key is read without echo, kept in a mode-restricted
temporary file, piped directly to Kubernetes, and removed afterward:

```sh
set -euo pipefail
umask 077
NAMESPACE=myota-test
RELEASE=myota-test
secret_file="$(mktemp)"
trap 'rm -f "$secret_file"; unset BIGDATACLOUD_API_KEY' EXIT
read -rsp 'BigDataCloud test API key: ' BIGDATACLOUD_API_KEY
printf '\n'
printf '%s' "$BIGDATACLOUD_API_KEY" > "$secret_file"
kubectl -n "$NAMESPACE" create secret generic myota-geodata-enrichment \
  --from-file=api-key="$secret_file" --dry-run=client -o yaml \
  | kubectl apply -f -
unset BIGDATACLOUD_API_KEY
kubectl -n "$NAMESPACE" rollout restart "deployment/${RELEASE}-geodata-worker"
kubectl -n "$NAMESPACE" rollout status "deployment/${RELEASE}-geodata-worker"
```

Use a new test key for rotation. Updating a Kubernetes Secret does not update
environment variables in an existing pod, so restart the worker after applying
the rotated key. Verify the rollout is healthy; never print the Secret or its
decoded data to a terminal or CI log.

## Qualification sequence

1. Confirm the test namespace and Geodata worker Deployment before applying the
   Secret. Keep the credential out of production namespaces and production
   systems.
2. Verify the Secret exists without displaying its contents:

   ```sh
   kubectl -n myota-test get secret myota-geodata-enrichment
   ```

3. Use the Admin UI's per-entity location retry on one test entity with geometry
   and missing provider-managed fields. Confirm the request reaches a terminal
   enriched state and records provider provenance. The worker handles requests
   asynchronously, so acceptance means queued work, not completed enrichment.
4. If the single-entity check succeeds, start **Fill missing location metadata
   from entities** in Admin Entity Management. Review the eligible count and
   submit the bounded asynchronous backfill.
5. Monitor queued, completed, skipped, and failed results. Re-read the catalogue
   after processing and confirm the missing fields were filled without
   overwriting manual values or geometry changes.
6. If requests fail, inspect status and sanitized worker logs without printing
   credentials. Correct provider configuration or rotate the test key, then
   retry a single entity before retrying a larger set.

The bulk action is safe to repeat for work already queued or complete. Do not
start it while the provider is unconfigured: those requests will not verify
provider-backed enrichment. Current deployment evidence and remaining limits
are tracked in [the Geodata parity record](../parity/geodata.md) and issues
[#110](https://github.com/myota-platform/myota-next/issues/110),
[#111](https://github.com/myota-platform/myota-next/issues/111), and
[#112](https://github.com/myota-platform/myota-next/issues/112).

## Earlier live no-key check

On 2026-10-27 at 23:55 UTC, Helm release `myota-test` used chart
`myota-next-1.1.6-testing.54b944d51999.1`. The
`myota-geodata-enrichment` Secret was absent. The Geodata worker remained Ready
(1/1), and all 16 release Deployments were available (21/21 replicas). This
confirmed the optional Secret reference was isolated to the worker and that it
could start without the provider credential. It did not verify a provider
request, a live API response of `NOT_CONFIGURED`, or secret rotation. The newer
revision 72 deployment is recorded in the [Geodata parity record](../parity/geodata.md).

## Test deployment evidence — 2026-10-28

A test-only key was provisioned in the `myota-test` namespace Secret
`myota-geodata-enrichment` under key `api-key`. The Geodata worker was restarted
to load the Secret and returned Ready at 1/1. An authenticated administrator
queued one eligible entity with its current entity version and a request
idempotency key. The API returned HTTP 202 (`QUEUED`); a fresh entity read then
showed `COMPLETED` / `ENRICHED`, provider `BIGDATACLOUD`, and saved location
metadata with a geocoding timestamp. The key itself was never displayed or
logged.

This single-entity API check does not qualify replacement-key rotation, lifecycle
triggers, queueing and monitoring the Admin browser workflow, or the
full-catalogue backfill. A browser check displayed a confirmation for the 432
matching entities; it was dismissed, and no enrichment requests were submitted.
