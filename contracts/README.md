# Contracts

The files in this directory serve two purposes:

- `reference/` is the checksum-verified, language-neutral snapshot from the
  original `myota` implementation. Do not edit it to make target comparisons
  pass.
- The files at this directory's root are the active contracts for this
  monorepo's processes.

The active OpenAPI file adds five target-only operations and revises six shared
operation definitions; see [`docs/api-baseline.md`](../docs/api-baseline.md).
The active event registry retains the same 68 facts and 11 work schemas as the
reference, and adds relay routing metadata and producer aliases for the new
runtime. The 81 JSON schemas are byte-identical to the reference snapshot.

Review active-contract changes against `reference/` and record whether they
restore source behavior, add target-specific operations, or leave a behavior
discrepancy unresolved. The migration snapshot lives separately in
[`docs/reference/migrations/`](../docs/reference/migrations/); active SQL
migrations remain under `deploy/db/migrations/`.
