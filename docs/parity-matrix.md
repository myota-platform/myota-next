# Function parity matrix

This is the acceptance inventory for the new implementation. The copied
`contracts/openapi.yaml` and event schemas are the first compatibility
baseline. The [API operation traceability index](api-operation-traceability.md)
maps contract operations to Nest controllers; it establishes source ownership,
not behavioral completion. Current implementation reference:
[`myota`](https://github.com/myota-platform/myota/tree/7f904a5130e59006765cf882956a4adbfecb17ec).

## Required behavior

| Area           | Required parity                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity       | Preserve the intentionally disabled public-registration response; login, refresh, logout, recovery, current profile and profile images; account creation and administration; role definition and assignment; callsign creation, evidence, verification, primary selection and retirement; OIDC mapping; service tokens; account export/deactivation; security events; authorization scopes and abuse controls.                                    |
| Programmes     | Programme create/read/update/archive; shared category catalog and programme assignments; programme content and policy draft lifecycle (save, submit, review, publish); configuration coverage and theme/content delivery.                                                                                                                                                                                                                         |
| Geodata        | Catalog search, paging, bounding box and tiles; source adapters; pasted imports and resumable multipart uploads; validation/preprocessing queues, duplicate warnings and promotion; provenance, audit, review and lifecycle; metadata, categories, geometry and location edits; asynchronous location enrichment; refresh schedules; conflation; authorized deletion with Activity impact calculation; retention.                                 |
| Activity       | Activation lifecycle; single and batch QSO writes with import provenance; ADIF and QSO ingestion; correction requests and review; public history, results, leaderboards and statistics; statistics rebuild; award design and lifecycle; conditions, levels, evaluation and progress; requests, issuance, assets, previews, certificate rendering and artifact retrieval; notification records and authorized operational views.                   |
| Email delivery | Preserve the `email.send.v1` work contract, Identity-owned recipient lookup, allowlisted templates, TLS SMTP, Core-owned deduplication and dead-letter ledger, bounded retry, audited recovery, privacy-safe telemetry, and separate worker deployment. The NestJS consumer, audited redrive CLI, Prometheus metrics, and optional OTLP traces, metrics, and logs are implemented; Identity production and deployment qualification remain gated. |

## Detailed behavior

- [HTTP compatibility](parity/http.md)
- [Identity and Programmes](parity/identity-programmes.md)
- [Activity](parity/activity.md)
- [Geodata](parity/geodata.md)
- [Web applications](parity/web-applications.md)
- [Workers and operations](parity/workers-operations.md)
- [Completion criteria](parity/completion-criteria.md)
