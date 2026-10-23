import { fromArrayBuffer } from 'geotiff';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import proj4 from 'proj4';
import definitions from '../data/epsg-proj4-definitions.json' with { type: 'json' };

proj4.defs(definitions as [string, string][]);

const spanishEd50Grid = 'es_ign_SPED2ETV2.tif';
const gridBuffer = await readFile(
  resolve(process.cwd(), 'libs/geodata-domain/data', spanishEd50Grid),
);
const gridArrayBuffer = gridBuffer.buffer.slice(
  gridBuffer.byteOffset,
  gridBuffer.byteOffset + gridBuffer.byteLength,
);
const gridTiff = await fromArrayBuffer(gridArrayBuffer);
const gridRegistration = proj4.nadgrid(
  spanishEd50Grid,
  gridTiff as unknown as Parameters<typeof proj4.nadgrid>[1],
);
await gridRegistration.ready;

const spanishGridBounds: Array<[number, number, number, number]> = [];
for (let index = 0; index < (await gridTiff.getImageCount()); index += 1) {
  const image = await gridTiff.getImage(index);
  const [west, south, east, north] = image.getBoundingBox();
  spanishGridBounds.push([west, south, east, north]);
}

/**
 * Reproject an EPSG coordinate to WGS84, applying Spain's published ED50 grid
 * when the transformed coordinate falls inside its coverage. Elsewhere the
 * bundled EPSG definitions retain their global fallback transformation.
 */
export function projectToWgs84(source: string, coordinate: number[]) {
  const normalizedSource = source.trim().toUpperCase();
  const fallback = proj4(source, 'EPSG:4326', coordinate);
  const epsgMatch = /^EPSG:\s*(\d+)$/.exec(normalizedSource);
  if (!epsgMatch) return fallback;

  const epsg = Number(epsgMatch[1]);
  const gridSource =
    epsg === 4230
      ? '+proj=longlat +ellps=intl +nadgrids=es_ign_SPED2ETV2.tif +no_defs'
      : epsg >= 23028 && epsg <= 23038
        ? `+proj=utm +zone=${epsg - 23000} +ellps=intl +nadgrids=es_ign_SPED2ETV2.tif +units=m +no_defs`
        : undefined;
  if (!gridSource) return fallback;

  const [longitude, latitude] = fallback;
  const inSpanishGrid = spanishGridBounds.some(
    ([west, south, east, north]) =>
      longitude >= west - 0.01 &&
      longitude <= east + 0.01 &&
      latitude >= south - 0.01 &&
      latitude <= north + 0.01,
  );
  if (!inSpanishGrid) return fallback;

  const shifted = proj4(gridSource, 'EPSG:4326', coordinate);
  return shifted.every(Number.isFinite) ? shifted : fallback;
}

export default proj4;
