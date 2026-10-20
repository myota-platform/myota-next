export function collectCoordinatePairs(value: unknown): [number, number][] {
  if (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number'
  )
    return [[value[0], value[1]]];
  if (!Array.isArray(value)) return [];
  return value.flatMap(collectCoordinatePairs);
}
