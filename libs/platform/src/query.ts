export function firstQueryValue(value: unknown): string | undefined {
  const values = Array.isArray(value) ? value : [value];
  return values.find(
    (item): item is string => typeof item === 'string' && item !== '',
  );
}
