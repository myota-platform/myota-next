# Completion criteria

Accelerated functional parity focuses on complete, common user workflows and
their persisted outcomes across APIs, the browser applications, and workers.
The core product areas in the [parity matrix](../parity-matrix.md) remain in
scope. The copied event registry contains 68 fact schemas and 11 work-command
schemas. The NestJS route guard confirms that all 141 OpenAPI operations have
controller routes; route presence is a useful inventory check, not behavioral
evidence.

For each product area, compatibility checks should exercise its main success path and
the shared authorization, validation, and conflict behavior that protects it. A
representative check can cover a behavior shared by many operations. Match exact error
text and obscure validation ordering only when they change an important user or security
outcome. Rare outage and recovery cases, production throughput, and deployment
qualification remain separate operational work; complete them before production use, not
before functional parity.

Browser checks should cover each primary user journey, with intercepted responses
allowed for secondary presentation states. Each target database must still initialize
from empty and persist its domain behavior correctly. Importing data from the old
platform remains out of scope.

The inventory must be refined against the current service checks, UI routes,
worker topology, and fresh-database schema before each area is declared complete.
Operational and production qualification are separate gates from API-level
parity.
