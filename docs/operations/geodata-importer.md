# Geodata source importer

The source importer is opt-in. Enable its Helm component and set
`GEODATA_IMPORTER_ENABLED` to `true` only after configuring the source hosts it
may contact. The chart passes `geodataImporter.sourceAllowlist` to
`GEODATA_SOURCE_ALLOWLIST` and `geodataImporter.pollSeconds` to
`GEODATA_IMPORTER_POLL_SECONDS`.

For example, add this to a deployment values file and explicitly enable the
component:

```yaml
geodataImporter:
  pollSeconds: 60
  sourceAllowlist:
    - data.example.org
components:
  geodata-importer:
    enabled: true
    replicas: 1
    env:
      GEODATA_IMPORTER_ENABLED: 'true'
```

Replace the sample host with the exact source domains in use. The importer
fetches only HTTPS URLs whose host exactly matches an allowlist entry or is a
subdomain of one. Source URLs cannot contain credentials, and redirects are
rejected. Each response is bounded by the shared source byte and feature
limits. Keep one replica unless duplicate source fetching is acceptable; API
idempotency prevents duplicate schedule submissions from applying twice.

The chart defaults keep the component disabled, use a 60-second poll interval,
and allow no source hosts. Qualify the selected live sources, source licenses,
allowlist, worker behavior during source outages, and production recovery
procedures before enabling it in production. See [Geodata parity](../parity/geodata.md)
for current behavioral coverage.
