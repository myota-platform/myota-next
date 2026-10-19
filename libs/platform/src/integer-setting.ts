export function integerSetting(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const normalized = value.trim();
  if (!/^[+-]?\d(?:_?\d)*$/.test(normalized))
    throw new Error('Integer settings must be base-10 integers');
  const parsed = BigInt(normalized.replaceAll('_', ''));
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  if (parsed > maximum) return Number.MAX_SAFE_INTEGER;
  if (parsed < -maximum) return -Number.MAX_SAFE_INTEGER;
  return Number(parsed);
}
