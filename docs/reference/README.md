# Reference database migrations

These eight SQL files preserve the application and deployment migration inputs
from `myota-platform/myota` at commit
`7f904a5130e59006765cf882956a4adbfecb17ec`. Their original directory groups
are retained under `migrations/app-migrations/` and `migrations/deploy-db/`.

The files are a comparison snapshot, not an executable migration source. The
active, owner-scoped migration sequence is in
[`deploy/db/migrations/`](../../deploy/db/migrations/). SHA-256 checksums for
the snapshot are in [`migrations/SHA256SUMS`](migrations/SHA256SUMS).
