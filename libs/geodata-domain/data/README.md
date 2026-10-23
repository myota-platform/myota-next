# EPSG Proj4 definitions

`epsg-proj4-definitions.json` is the 4,758-entry dataset from
[`proj4js-definitions@0.1.0`](https://github.com/DanielJDufour/proj4js-definitions),
licensed under CC0 1.0 (see the accompanying license). Its upstream project
says the source CRS CSV was made by scraping epsg.io. It is bundled locally so
coordinate imports do not depend on an external service at runtime.

This expands Proj4js beyond its built-in definitions. It is not a replacement
for PROJ's full operation database: some CRS transformations require datum-grid
files, and their accuracy must be checked against the pinned PyProj reference.
The compatibility fixtures cover representative Polar Stereographic, British,
New Zealand, U.S. Albers, Swiss, Dutch, and ETRS89 UTM coordinates.

To refresh the dataset, review the upstream source, license, code count, and
coordinate fixtures together. Do not refresh the file without regenerating the
reference comparisons.
