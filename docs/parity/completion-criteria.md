# Completion criteria

Parity is complete only when every current OpenAPI operation and registered
event is mapped to an implementation and automated compatibility check, and
when user workflows and worker behavior have equivalent tests. The copied
event registry currently contains 68 fact schemas and 11 work-command schemas.
The NestJS route guard confirms that all 140 OpenAPI operations have controller
routes; this verifies route presence only, not request, response, authorization,
or persistence parity.
Checks must
cover success, authorization, validation, conflicts, persistence, retries,
redelivery, idempotency, and failure recovery where relevant. UI parity also
requires browser-level workflow coverage. Database parity includes migration
and data-transfer checks for all three database targets.

The inventory must be refined against the current service tests, UI routes,
worker topology, and migration data before each area is declared complete.
Operational and production qualification are separate gates from API-level
parity.
