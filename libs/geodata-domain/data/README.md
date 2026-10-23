# Geodata projection data

`es_ign_SPED2ETV2.tif` is the Spanish ED50 to ETRS89 horizontal datum grid
distributed by [OSGeo PROJ-data](https://github.com/OSGeo/PROJ-data). Its
underlying data is from Spain's Instituto Geográfico Nacional (IGN), derived
from original IGN data under CC BY 4.0. Attribution: Instituto Geográfico
Nacional (IGN), Spain. See the [IGN data policy](https://www.ign.es/web/ign/portal/politica-datos)
and the [PROJ-data source note](https://github.com/OSGeo/PROJ-data/blob/master/es_ign/es_ign_README.txt).

The grid covers mainland Spain and the Balearic Islands. It is used for
horizontal ED50 coordinates when their WGS84 fallback position is inside the
grid extent; other locations keep the bundled EPSG fallback transformation.

The checked-in file is 180,404 bytes with SHA-256
`61896f5d74bdc7c1d5850839ae743b08e19f9a627e8febb4ac93353ded835961`.
