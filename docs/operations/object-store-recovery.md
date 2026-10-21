# Object-store recovery

Geodata upload sessions keep multipart state in the Geodata database and
uploaded bytes in S3-compatible object storage. If an upload-part request fails
during a temporary store outage, restore the object store and retry the same
upload ID and part number with the same bytes. The API writes the part metadata
only after object storage acknowledges the part. Completion can then continue
through the normal upload workflow.

The CI qualification uses the pinned SeaweedFS image, stops the server after
part 1, verifies a failed part 2 leaves no database part row, restarts SeaweedFS
with its original data volume, retries part 2, completes the upload, and checks
the stored bytes and queued import. This covers one process restart with local
data retained. It does not qualify clustered failover, permanent volume loss,
other object-store consumers, or production recovery procedures.
