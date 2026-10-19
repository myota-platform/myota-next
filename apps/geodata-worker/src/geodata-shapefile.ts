import { unzipSync } from 'fflate';
import shp from 'shpjs';

const MAX_MEMBERS = 100;
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_PROJECTION_BYTES = 1024 * 1024;

export async function decodeShapefileArchive(
  archive: Uint8Array,
  filename: string,
): Promise<{ type: 'FeatureCollection'; features: unknown[] }> {
  if (!filename.toLowerCase().endsWith('.zip'))
    throw new Error('Shapefile imports must be ZIP archives');

  let members = 0;
  let expandedBytes = 0;
  const names = new Set<string>();
  const entries = unzipSync(archive, {
    filter: (file) => {
      members += 1;
      expandedBytes += file.originalSize;
      const normalizedName = file.name.toLowerCase();
      if (names.has(normalizedName))
        throw new Error('Shapefile ZIP contains duplicate file names');
      names.add(normalizedName);
      if (members > MAX_MEMBERS)
        throw new Error(`Shapefile ZIP has more than ${MAX_MEMBERS} files`);
      if (expandedBytes > MAX_EXPANDED_BYTES)
        throw new Error('Shapefile ZIP expands beyond 64 MiB');
      if (
        normalizedName.endsWith('.prj') &&
        file.originalSize > MAX_PROJECTION_BYTES
      )
        throw new Error('Shapefile projection metadata exceeds 1 MiB');
      if (
        normalizedName.includes('__macosx/') ||
        normalizedName.split('/').at(-1)?.startsWith('._')
      )
        return false;
      return /\.(shp|shx|dbf|prj|cpg)$/i.test(file.name);
    },
  });

  const shapeFiles = Object.keys(entries).filter((name) =>
    name.toLowerCase().endsWith('.shp'),
  );
  if (shapeFiles.length !== 1)
    throw new Error('Shapefile ZIP must contain exactly one .shp file');

  const shapePath = shapeFiles[0];
  const stem = shapePath.slice(0, -4).toLowerCase();
  const entryFor = (extension: string) =>
    Object.keys(entries).find(
      (name) => name.toLowerCase() === `${stem}.${extension}`,
    );
  const shapeIndex = entryFor('shx');
  const attributes = entryFor('dbf');
  if (!shapeIndex || !attributes)
    throw new Error('Shapefile ZIP must include matching .shx and .dbf files');

  const projection = entryFor('prj');
  const encoding = entryFor('cpg');
  const result = await shp({
    shp: entries[shapePath],
    shx: entries[shapeIndex],
    dbf: entries[attributes],
    ...(projection ? { prj: entries[projection] } : {}),
    ...(encoding ? { cpg: entries[encoding] } : {}),
  });
  if (result.type !== 'FeatureCollection' || !Array.isArray(result.features))
    throw new Error('Shapefile decoder did not produce a FeatureCollection');
  if (!result.features.length)
    throw new Error('Shapefile archive contains no features');
  return result;
}
