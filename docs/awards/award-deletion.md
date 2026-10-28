# Permanent award deletion

Permanent deletion is limited to accounts holding the platform role
`GLOBAL_ADMIN` or `GLOBAL_OPERATOR`. The Activity API checks that role on both
the deletion request and status reads; the Admin UI control is only a
convenience and does not grant authority.

Deleting one award removes its full programme and code version family, award
requests, issued-award records, calculated progress, and generated certificate
PDFs. Registered backgrounds and signatures belong to the shared asset library,
so they remain registered and available after their award reference is removed.

## Request and completion

The Admin action names the award and explains that deletion is irreversible.
It creates a durable Activity job and changes every version in the family to
`DELETING` in one Activity database transaction. While cleanup is pending, the
award is no longer available for publication, evaluation, or new issuance.

The UI polls the job until it reaches `SUCCEEDED` or `FAILED`. The worker locks
the award family and related issue records, then removes generated PDF files
before deleting database rows. Object-store deletion is idempotent, so a retry
can safely repeat files already removed. If file cleanup fails, the database
transaction rolls back and the job retries; records and the audit entry are
not removed prematurely. A terminal failure remains visible and can be
retried from the selected award.

On success, the worker inserts an immutable row in
`activity_award_deletion_audit` in the same transaction that removes the award
aggregate. The audit row records the initiating actor, programme and award
code, deleted version identifiers, and job identifier. It intentionally has
no foreign key to the deleted award.

The API is documented in [`contracts/openapi.yaml`](../../contracts/openapi.yaml):

- `POST /v1/awards/{awardId}/deletion-jobs` returns `202` and a job identifier.
- `GET /v1/awards/deletion-jobs/{jobId}` returns status and retry details.

The request accepts an `Idempotency-Key`. A repeated request while a job is
queued or running returns that active job. If a job ends in failure, a new
request starts another safe cleanup attempt.
