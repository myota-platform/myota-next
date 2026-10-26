import { integerSetting } from './integer-setting.js';

export const MAX_UPLOAD_BYTES = integerSetting(
  process.env.MYOTA_UPLOAD_MAX_BYTES,
  1024 ** 3,
);
export const MAX_GEOJSON_UPLOAD_BYTES = integerSetting(
  process.env.MYOTA_GEOJSON_MAX_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
);
export const MAX_OSM_PBF_UPLOAD_BYTES = integerSetting(
  process.env.MYOTA_OSM_PBF_MAX_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
);
export const MAX_SHAPEFILE_UPLOAD_BYTES = integerSetting(
  process.env.MYOTA_SHAPEFILE_MAX_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
);
/** Scheduled source fetching buffers and parses the whole JSON response. */
export const MAX_GEODATA_SOURCE_FETCH_BYTES = integerSetting(
  process.env.GEODATA_SOURCE_MAX_BYTES,
  32 * 1024 * 1024,
);
export const MAX_IMPORT_FEATURE_BYTES = integerSetting(
  process.env.MYOTA_IMPORT_MAX_FEATURE_BYTES,
  16 * 1024 * 1024,
);
export const MAX_IMPORT_FEATURES = integerSetting(
  process.env.GEODATA_MAX_IMPORT_FEATURES,
  5000,
);
export const IMPORT_RUN_LEASE_SECONDS = Math.max(
  60,
  integerSetting(process.env.MYOTA_IMPORT_LEASE_SECONDS, 900),
);
export const IMPORT_RUN_HEARTBEAT_SECONDS = Math.max(
  15,
  integerSetting(process.env.MYOTA_IMPORT_HEARTBEAT_SECONDS, 30),
);
export const MAX_IMPORT_FEATURE_VERTICES = integerSetting(
  process.env.MYOTA_IMPORT_MAX_FEATURE_VERTICES,
  250_000,
);
export const MAX_SHAPEFILE_EXPANDED_BYTES = integerSetting(
  process.env.MYOTA_IMPORT_MAX_SHAPEFILE_EXPANDED_BYTES,
  1024 ** 3,
);
export const MAX_IMPORT_BATCH_BYTES = Math.max(
  1,
  integerSetting(process.env.MYOTA_IMPORT_BATCH_BYTES, 32 * 1024 * 1024),
);
export const MAX_IMPORT_BATCH_FEATURES = Math.max(
  1,
  integerSetting(process.env.MYOTA_IMPORT_BATCH_SIZE, 100),
);
