# Contracts

The files in this directory serve two purposes:

- `reference/` is the checksum-verified, language-neutral snapshot from the
  original `myota` implementation. Do not edit it to make target comparisons
  pass.
- The files at this directory's root are the active contracts for this
  monorepo's processes.

The active OpenAPI file adds five target-only operations and revises six shared
operation definitions; see [`docs/api-baseline.md`](../docs/api-baseline.md).
The active event registry has 75 facts and 11 work schemas. Six target-only
Identity security facts are registered for email changes and profile images;
the rest preserve the 69-fact reference inventory and add relay routing
metadata and producer aliases for the new runtime. The 82 reference schemas
remain unchanged; the six additional active event schemas bring the active
schema count to 88.

Review active-contract changes against `reference/` and record whether they
restore source behavior, add target-specific operations, or leave a behavior
discrepancy unresolved. The migration snapshot lives separately in
[`docs/reference/migrations/`](../docs/reference/migrations/); active SQL
migrations remain under `deploy/db/migrations/`.
