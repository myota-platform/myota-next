# Programme configuration guide

The Programme Editor is designed so programme owners can configure their own
policy without inheriting rules from another programme. The current common
controls cover minimum activation QSOs, minimum hunter QSOs, activation
validity, public-access requirements, overlap handling, shared category
assignments, and theme colors.

This is an initial configuration slice, not yet a complete programme control
plane. The authoritative audit of missing configuration is in
[`myota-docs/docs/programme-configuration-gap-analysis.md`](https://github.com/myota-platform/myota-docs/blob/main/docs/programme-configuration-gap-analysis.md).

## Current coverage and remaining gaps

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

Still missing from Programme Management:

- programme owner/contact/legal metadata and a draft → review → published →
  suspended/retired lifecycle with immutable configuration versions;
- a programme-owned locale catalogue, default locale, ordered fallback chain,
  required content keys, and translation import/export;
- jurisdiction hierarchy/boundaries and programme + jurisdiction + category
  approver-scope management;
- schema-driven forms for activation, QSO, evidence, callsign, geodata
  eligibility, moderation, overlap, privacy, and public-output policies;
- policy validation, version comparison, historical snapshots, and a dry-run
  rule simulator;
- editing/testing the existing per-programme OIDC mapping and its claims,
  domains, and account-linking policy; and
- programme notification, privacy, leaderboard/history, statistics, and
  award-linkage defaults.

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
