# Geodata importer

The importer supports scheduled refreshes and one-shot complete snapshots.

For scheduled refreshes, set `GEODATA_IMPORTER_ENABLED=true`, configure
`MYOTA_AUTH_SIGNING_KEY`, `MYOTA_GEODATA_URL`, and
`GEODATA_SOURCE_ALLOWLIST`, and start the `geodata-importer` NestJS app. It
polls database-backed refresh schedules at `GEODATA_IMPORTER_POLL_SECONDS`
(60 seconds by default).

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
redirects, apply the shared import feature limit, and submit through the
Geodata API. `MYOTA_GEODATA_URL` defaults to `http://geodata:8003`.
