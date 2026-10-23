# Reference contract snapshot

These files preserve the language-neutral API and event-contract inputs from
the current implementation before target-specific contract edits.

- Source repository: `myota-platform/myota`
- Source commit: `7f904a5130e59006765cf882956a4adbfecb17ec`
- Snapshot files: `openapi.yaml`, `event-registry.json`, and `schemas/`
- Checksums: [`SHA256SUMS`](SHA256SUMS)

This directory is a frozen comparison baseline. Runtime code and generators
must continue to use the active contracts in the parent `contracts/` directory.
When an active contract changes, compare it with this snapshot and record
whether the change is a parity fix, a target-only extension, or an unresolved
behavior difference. Do not update the snapshot to make a comparison pass.
