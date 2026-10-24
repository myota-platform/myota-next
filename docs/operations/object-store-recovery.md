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
[operational qualification run 40097566429](https://github.com/myota-platform/myota-next/actions/runs/40097566429).
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

The object-store recovery guide does not yet qualify clustered storage
failover, backup/restore, recovery after permanent volume loss in the deployed
topology, or operator recovery procedures.
