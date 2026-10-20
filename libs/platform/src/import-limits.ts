const DEFAULT_IMPORT_FEATURE_BYTES = 16 * 1024 * 1024;
const configuredFeatureBytes = process.env.MYOTA_IMPORT_MAX_FEATURE_BYTES;

export const MAX_IMPORT_FEATURE_BYTES =
  configuredFeatureBytes === undefined
    ? DEFAULT_IMPORT_FEATURE_BYTES
    : parseIntegerSetting(configuredFeatureBytes);

function parseIntegerSetting(value: string): number {
  const normalized = value.trim();
  if (!/^[+-]?\d(?:_?\d)*$/.test(normalized))
    throw new Error('MYOTA_IMPORT_MAX_FEATURE_BYTES must be an integer');
  const parsed = Number(normalized.replaceAll('_', ''));
  if (!Number.isSafeInteger(parsed))
    return normalized.startsWith('-')
      ? Number.MIN_SAFE_INTEGER
      : Number.MAX_SAFE_INTEGER;
  return parsed;
}
