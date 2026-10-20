import { stringifyJsonWithBigInts } from '@app/platform/json-bigint.js';
import { trimPythonWhitespace } from '@app/platform/python-strings.js';
import { firstPythonTruthy } from '@app/platform/python-truthiness.js';

export { firstPythonTruthy } from '@app/platform/python-truthiness.js';

const entityTypePattern = /^[A-Z][A-Z0-9_]{1,63}$/;

export function normalizeEntityTypeCodes(
  value: unknown,
  fallback?: unknown,
): string[] {
  const raw = value == null ? fallback : value;
  const selected = isRecord(raw)
    ? firstPythonTruthy(raw.code, raw.entityType)
    : raw;
  const values =
    typeof selected === 'string'
      ? [selected]
      : Array.isArray(selected)
        ? selected
        : [];
  const result: string[] = [];
  for (const item of values) {
    const code = trimPythonWhitespace(
      pythonString(isRecord(item) ? item.code : item),
    ).toUpperCase();
    if (code && entityTypePattern.test(code) && !result.includes(code))
      result.push(code);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pythonString(value: unknown): string {
  if (value == null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'object') return stringifyJsonWithBigInts(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint')
    return String(value);
  if (typeof value === 'symbol') return value.description ?? '';
  return '';
}
