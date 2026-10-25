# Object-store recovery

Geodata upload sessions keep multipart state in the Geodata database and
uploaded bytes in S3-compatible object storage. If an upload-part request fails
during a temporary store outage, restore the object store and retry the same
upload ID and part number with the same bytes. The API writes the part metadata
only after object storage acknowledges the part. Completion can then continue
through the normal upload workflow.

The operational qualification uses the pinned SeaweedFS image. It stops the
server after part 1, verifies a failed part 2 leaves no database part row,
restarts SeaweedFS with its original data volume, retries part 2, completes the
upload, and checks the stored bytes and queued import. It then uploads both
parts of a second session, deletes SeaweedFS's local data volume, and verifies
completion marks that session `FAILED` without creating an import run or
outbox event. The operator-facing conflict requires starting a new upload, and
the fixture cleans up both sessions. These cases passed in
[operational qualification run 40098768950](https://github.com/myota-platform/myota-next/actions/runs/40098768950).
The permanent-loss check verifies safe application state; it does not recover
the lost bytes or qualify clustered failover or production storage procedures.

The Geodata worker recovery qualification also injects a failed source-object
read during import preprocessing. It verifies the owning database returns the
run to a retryable state, the same JetStream delivery is retried, preprocessing
completes after the object store recovers, and the final staged candidate is
present once with no dead letter. This check injects the outage at the S3 client
boundary; deployment-level object-store and persistent-volume failures remain
unqualified.

The same qualification covers Activity ADIF import and certificate rendering
retrying a temporary object-store outage. ADIF checks verify no partial QSO or
failed-import notification is committed before retry; rendering checks verify
failed storage does not mark the artifact ready and a retry succeeds. Identity
profile-image upload has a focused unit test for a failed S3 write: the
transaction rolls back without replacing the existing image reference. That
test uses a mocked database and S3 client; an integrated outage and deployed
storage recovery path for profile images are not yet qualified.

## Deployed `myota-test` checks

On 2026-10-25, deployed storage checks covered Activity ADIF API upload and
worker reads, Identity profile-image writes, Geodata multipart sessions and
preprocessing source reads, and Activity PDF artifact writes. The API-level
Identity and Geodata failures returned HTTP 500 but preserved database state;
caller retry succeeded after storage recovered. Activity ADIF API upload
returned HTTP 503 and a retried worker accepted exactly one QSO. A transient
Geodata S3 source-read refusal recovered on attempt 2 with one candidate, zero
errors, and one completion event. A full SeaweedFS pod stop exceeded the
Geodata worker's then-configured three-attempt limit and ended that probe in
`FAILED`; see the [single-instance recovery
guide](single-instance-restart-recovery.md) for the result and the planned
retry-budget follow-up.

For PDF rendering, an in-cluster proxy allowed the certificate asset reads and
returned three `503 ServiceUnavailable` responses for the artifact `PutObject`.
The deployed Activity worker retried the same job and succeeded on attempt 2.
The issuance became ready, the artifact had a valid `%PDF` header, one render
event was persisted, and the durable settled with no pending messages.

Persistent-volume continuity was checked by writing a unique object, replacing
the SeaweedFS pod, and verifying the same bytes and SHA-256 digest afterward.
The 20 GiB `local-path` PVC remained bound. The StatefulSet retains its claim
when scaled or deleted, while the StorageClass's PV reclaim policy is `Delete`.
Do not delete the PVC as part of pod recovery. This check covers pod
replacement with the same volume; it does not cover node or permanent-volume
loss, backup, or restore.

The profile-image unit test passed in [Node CI run
40098386128](https://github.com/myota-platform/myota-next/actions/runs/40098386128).

The object-store recovery guide does not yet qualify clustered storage
failover, backup/restore, recovery after permanent volume loss in the deployed
topology, or operator recovery procedures.
