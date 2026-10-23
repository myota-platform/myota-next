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
  const embeddedEpsg =
    epsgFromWktAuthority(source) ?? spanishEd50EpsgFromWkt2(source);
  const epsgMatch = /^EPSG:\s*(\d+)$/.exec(normalizedSource);
  const epsg = epsgMatch?.[1] ?? embeddedEpsg;
  const projectionSource = epsg ? `EPSG:${epsg}` : source;
  const fallback = proj4(projectionSource, 'EPSG:4326', coordinate);
  const gridSource = epsg
    ? spanishGridSourceForEpsg(Number(epsg))
    : spanishGridSourceForWkt(source);
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

/** Resolve a WKT2 root CRS authority before passing WKT to proj4js. */
function epsgFromWktAuthority(source: string): string | undefined {
  const root =
    /^\s*(?:PROJCRS|GEOGCRS|GEODCRS|COMPOUNDCRS|BOUNDCRS)\s*\[/i.exec(source);
  if (!root) return undefined;

  let depth = 1;
  let quoted = false;
  let epsg: string | undefined;
  let rootEnd = -1;
  for (let index = root[0].length; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (quoted) continue;

    if (depth === 1) {
      const authority = /^(?:ID|AUTHORITY)\s*\[\s*"EPSG"\s*,\s*"?(\d+)"?/i.exec(
        source.slice(index),
      );
      if (authority) epsg = authority[1];
    }

    if (character === '[') depth += 1;
    else if (character === ']') {
      depth -= 1;
      if (depth === 0) {
        rootEnd = index;
        break;
      }
    }
  }
  return rootEnd >= 0 && !source.slice(rootEnd + 1).trim() ? epsg : undefined;
}

/** Resolve common custom ED50 WKT2 definitions to the bundled EPSG baseline. */
function spanishEd50EpsgFromWkt2(source: string): string | undefined {
  const root = /^\s*(PROJCRS|GEOGCRS|GEODCRS)\s*\[/i.exec(source)?.[1];
  if (!root) return undefined;

  const normalized = source.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
  if (
    !normalized.includes('europeandatum1950') ||
    !normalized.includes('international1924')
  )
    return undefined;
  const ellipsoid =
    /ELLIPSOID\s*\[\s*"[^"]+"\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(source);
  if (
    Number(ellipsoid?.[1]) !== 6378388 ||
    Number(ellipsoid?.[2]) !== 297 ||
    !/PRIMEM\s*\[\s*"Greenwich"\s*,\s*0(?:\.0*)?\s*,/i.test(source) ||
    !/ANGLEUNIT\s*\[\s*"degree"\s*,/i.test(source)
  )
    return undefined;

  const angleUnits = [...source.matchAll(/ANGLEUNIT\s*\[\s*"([^"]+)"/gi)].map(
    (match) => match[1]?.toLowerCase(),
  );
  const lengthUnits = [...source.matchAll(/LENGTHUNIT\s*\[\s*"([^"]+)"/gi)].map(
    (match) => match[1]?.toLowerCase(),
  );
  if (
    !angleUnits.length ||
    angleUnits.some((unit) => unit !== 'degree') ||
    !lengthUnits.length ||
    lengthUnits.some((unit) => unit !== 'metre')
  )
    return undefined;

  if (root.toUpperCase() !== 'PROJCRS') return '4230';
  const method = /METHOD\s*\[\s*"([^"]+)"/i
    .exec(source)?.[1]
    ?.toLowerCase()
    .replaceAll(/[^a-z0-9]/g, '');
  if (method !== 'transversemercator') return undefined;

  const parameter = (name: string) => {
    const escapedName = name.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const value = new RegExp(
      `PARAMETER\\s*\\[\\s*"${escapedName}"\\s*,\\s*([-+]?\\d+(?:\\.\\d*)?(?:[eE][-+]?\\d+)?)`,
      'i',
    ).exec(source)?.[1];
    return value === undefined ? undefined : Number(value);
  };
  const latitudeOfOrigin = parameter('Latitude of natural origin');
  const centralMeridian = parameter('Longitude of natural origin');
  const scaleFactor = parameter('Scale factor at natural origin');
  const falseEasting = parameter('False easting');
  const falseNorthing = parameter('False northing');
  if (
    latitudeOfOrigin !== 0 ||
    scaleFactor !== 0.9996 ||
    falseEasting !== 500000 ||
    falseNorthing !== 0 ||
    centralMeridian === undefined
  )
    return undefined;

  const zone = Math.round((centralMeridian + 183) / 6);
  if (
    zone < 28 ||
    zone > 38 ||
    Math.abs(centralMeridian - (zone * 6 - 183)) > 1e-9
  )
    return undefined;
  return String(23000 + zone);
}

function spanishGridSourceForEpsg(epsg: number): string | undefined {
  if (epsg === 4230)
    return '+proj=longlat +ellps=intl +nadgrids=es_ign_SPED2ETV2.tif +no_defs';
  if (epsg >= 23028 && epsg <= 23038)
    return `+proj=utm +zone=${epsg - 23000} +ellps=intl +nadgrids=es_ign_SPED2ETV2.tif +units=m +no_defs`;
  return undefined;
}

function spanishGridSourceForWkt(source: string): string | undefined {
  const projection = proj4.Proj(source) as unknown as Record<string, unknown>;
  const datumCode =
    typeof projection.datumCode === 'string'
      ? projection.datumCode.toLowerCase().replaceAll(/[^a-z0-9]/g, '')
      : '';
  if (datumCode !== 'european1950') return undefined;

  const projectionName =
    typeof projection.projName === 'string'
      ? projection.projName.toLowerCase().replaceAll(/[^a-z0-9]/g, '')
      : '';
  if (projectionName === 'longlat')
    return '+proj=longlat +ellps=intl +nadgrids=es_ign_SPED2ETV2.tif +no_defs';

  if (
    !['tmerc', 'transversemercator', 'extendedtransversemercator'].includes(
      projectionName,
    ) ||
    projection.ellps !== 'intl' ||
    projection.x0 !== 500000 ||
    projection.y0 !== 0 ||
    projection.k0 !== 0.9996 ||
    projection.lat0 !== 0 ||
    typeof projection.long0 !== 'number'
  )
    return undefined;

  const centralMeridian = (projection.long0 * 180) / Math.PI;
  const zone = Math.round((centralMeridian + 183) / 6);
  if (zone < 28 || zone > 38) return undefined;
  return `+proj=utm +zone=${zone} +ellps=intl +nadgrids=es_ign_SPED2ETV2.tif +units=m +no_defs`;
}

export default proj4;
