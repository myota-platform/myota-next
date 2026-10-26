# Geodata importer

The importer supports scheduled refreshes and one-shot complete snapshots.

For scheduled refreshes, set `GEODATA_IMPORTER_ENABLED=true`, configure
`MYOTA_AUTH_SIGNING_KEY`, `MYOTA_GEODATA_URL`, and
`GEODATA_SOURCE_ALLOWLIST`, and start the `geodata-importer` NestJS app. It
polls database-backed refresh schedules at `GEODATA_IMPORTER_POLL_SECONDS`
(60 seconds by default). Scheduled imports remain disabled unless explicitly
enabled. The allowlist is empty by default and matches an exact host or its
subdomains. Do not add a host until its license and attribution requirements,
response limits, outage behavior, and retry policy have been reviewed.

For a one-shot import, set `GEODATA_IMPORT_SPEC` to a JSON object with
`programmeSlug`, `adapter`, and a `source` object containing an allowlisted
HTTPS `url`. The optional fields are `geodataUrl`, `accessToken`,
`idempotencyKey`, and `disappearancePolicy`. If `accessToken` is omitted, the
importer signs a short-lived `geodata.import` service token using
`MYOTA_AUTH_SIGNING_KEY`; when supplied, the explicit token is used. The source
may use `GEOJSON` or `ARCGIS_FEATURESERVER` format. One-shot mode takes
precedence over scheduled mode, submits the complete snapshot to the Geodata
API, prints its JSON response, and exits.

Both modes fetch only from hosts in `GEODATA_SOURCE_ALLOWLIST`, reject
redirects, require source license and attribution metadata, apply the shared
import feature limit, and submit through the Geodata API. The response is
limited by `GEODATA_SOURCE_MAX_BYTES` (32 MiB by default) because the current
fetcher parses a complete JSON document in memory. The byte limit is enforced
against both `Content-Length` and streamed response bytes. Upload-based imports
use their separate streaming and spool limits. `MYOTA_GEODATA_URL` defaults to
`http://geodata:8003`.

Each source may set positive integer `maxBytes` and `maxFeatures` fields to use
stricter per-source limits. These can lower the global 32 MiB response and
5,000-feature caps, but cannot raise them. Invalid values fail before the source
is fetched.

Scheduled failures are retried after a 60-second in-process delay. Schedule
submission uses an idempotency key tied to the schedule's due time, so a lost
HTTP response does not create a second import run. The retry delay resets when
the importer process restarts; persistent retry scheduling is not implemented.
