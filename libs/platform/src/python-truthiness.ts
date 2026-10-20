export function pythonTruthy(value: unknown): boolean {
  if (value == null || value === false) return false;
  if (typeof value === 'string' || Array.isArray(value))
    return value.length > 0;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'bigint') return value !== 0n;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

export function firstPythonTruthy(...values: unknown[]): unknown {
  return values.find(pythonTruthy);
}
