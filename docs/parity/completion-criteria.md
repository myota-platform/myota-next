# Completion criteria

Parity is complete only when every current OpenAPI operation and registered
event is mapped to an implementation and automated compatibility check, and
when user workflows and worker behavior have equivalent checks. The copied
event registry currently contains 68 fact schemas and 11 work-command schemas.
The NestJS route guard confirms that all 140 OpenAPI operations have controller
routes; this verifies route presence only, not request, response, authorization,
or persistence parity.
Checks must
cover success, authorization, validation, conflicts, persistence, retries,
redelivery, idempotency, and failure recovery where relevant. UI parity also
requires browser-level workflow coverage. Each of the three databases must
initialize from an empty database with its owner migrations and persist its
domain behavior correctly. Importing data from the old platform is out of scope.

The inventory must be refined against the current service checks, UI routes,
worker topology, and fresh-database schema before each area is declared complete.
Operational and production qualification are separate gates from API-level
parity.
