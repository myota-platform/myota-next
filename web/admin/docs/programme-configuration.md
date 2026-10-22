# Programme configuration guide

The Programme Editor is designed so programme owners can configure their own
policy without inheriting rules from another programme. The current common
controls cover minimum activation QSOs, minimum hunter QSOs, activation
validity, public-access requirements, overlap handling, shared category
assignments, and theme colors.

This editor implements the programme configuration exposed by the pinned
Python reference: name, description, shared category assignments, common
activation rules, and theme colors. Content and policy use their separate
versioned workflows. The larger programme-control-plane proposals in the
[programme configuration gap analysis](https://github.com/myota-platform/myota-docs/blob/main/docs/programme-configuration-gap-analysis.md)
are future product work; they are not requirements for parity with that
reference. Existing locale coverage and published content delivery remain part
of parity.

## Current coverage

Already available in the editor or adjacent administration flows:

- programme name, slug, description, archive state, common QSOs/validity
  rules, overlap flag, and primary/accent colors;
- shared entity-category assignments, including multiple geometry types per
  category and categories reused by several programmes;
- policy and award draft workflow with explicit review/publication and
  effective dates;
- localized content drafts, fallback field, publication workflow, and
  coverage reporting; and
- activity-owned award definitions and identity-owned role/callsign/OIDC
  primitives.

The broader proposals remain available in the linked gap analysis for product
planning. They should be promoted into the parity inventory only if the
reference implementation or a separate product decision requires them.

Concrete award definitions, artwork, signatures, issuance, and certificates
remain owned by `myota-activity-service`; geodata imports remain deliberately
programme-independent. Programme configuration only links to those resources
and defines the programme's acceptance and execution policy.

## Entity categories (JSON compatibility projection)

Entity categories are shared Master data, not owned by one programme. The
Programme Editor keeps its JSON projection for compatibility, while the
Master data page defines the catalogue and Programme Management assigns shared
categories to one or more programmes. Geodata imports and review use the full
database-backed catalogue even when an entity has no programme assignment.

The editor intentionally keeps this field in JSON until a dedicated category
builder is added.

Use an array of objects. Each object should contain:

- `code`: stable machine identifier used by imports and historical records.
- `label`: human-readable name shown to administrators and participants.
- `geometry` or `geometryTypes`: accepted GeoJSON/PostGIS geometry types. The
  supported values are `POINT`, `LINESTRING`, `MULTILINESTRING`, `POLYGON`,
  and `MULTIPOLYGON`; one category can allow more than one type.

Example:

```json
[
  {
    "code": "MUNICIPAL_PARK",
    "label": "Municipal park",
    "geometryTypes": ["POLYGON", "MULTIPOLYGON"]
  },
  {
    "code": "RIVERSIDE_SITE",
    "label": "Riverside site",
    "geometryTypes": ["POLYGON"]
  }
]
```

Codes should not be renamed after publication. Existing entities, imports, and
historical activity records may refer to them. If the meaning changes, create
a new code and retire the old one through a future policy version.

Programme owners may add metadata fields, but the platform currently relies on
the three fields above for display, import normalization, and geometry checks.
The JSON describes category assignments and geometry hints only; eligibility,
access rules, awards, and approval policy remain programme-owned configuration.
