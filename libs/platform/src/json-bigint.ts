import { isJsonFloatingField } from './json-exact.js';
import { pythonFloatString } from './python-number.js';

export function containsBigInt(value: unknown): boolean {
  const visited = new Set<object>();
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === 'bigint') return true;
    if (current === null || typeof current !== 'object' || visited.has(current))
      continue;
    visited.add(current);
    pending.push(...Object.values(current));
  }
  return false;
}

export function stringifyJsonWithBigInts(value: unknown): string {
  return stringifyJsonWithMetadata(value);
}

/** Preserve JSON float-token metadata and BigInt values while serializing. */
export function stringifyJsonWithMetadata(value: unknown): string {
  const ancestors = new Set<object>();
  const serialize = (
    item: unknown,
    key: string,
    parent?: object,
  ): string | undefined => {
    if (
      item !== null &&
      (typeof item === 'object' || typeof item === 'function') &&
      typeof (item as { toJSON?: unknown }).toJSON === 'function'
    )
      item = (item as { toJSON: (key: string) => unknown }).toJSON(key);

    if (item === null) return 'null';
    if (typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'boolean') return item ? 'true' : 'false';
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) return 'null';
      return parent && isJsonFloatingField(parent, key)
        ? jsonFloatToken(item)
        : JSON.stringify(item);
    }
    if (typeof item === 'bigint') return item.toString();
    if (
      item === undefined ||
      typeof item === 'function' ||
      typeof item === 'symbol'
    )
      return undefined;
    if (typeof item !== 'object') return undefined;
    if (ancestors.has(item))
      throw new TypeError('Converting circular structure to JSON');

    ancestors.add(item);
    try {
      if (Array.isArray(item))
        return `[${Array.from(
          { length: item.length },
          (_, index) => serialize(item[index], String(index), item) ?? 'null',
        ).join(',')}]`;
      const entries: string[] = [];
      for (const property of Object.keys(item)) {
        const encoded = serialize(
          (item as Record<string, unknown>)[property],
          property,
          item,
        );
        if (encoded !== undefined)
          entries.push(`${JSON.stringify(property)}:${encoded}`);
      }
      return `{${entries.join(',')}}`;
    } finally {
      ancestors.delete(item);
    }
  };
  return serialize(value, '') as string;
}

function jsonFloatToken(value: number): string {
  const representation = pythonFloatString(value);
  const exponentIndex = representation.indexOf('e');
  if (exponentIndex < 0) return representation;

  // Keep a decimal point so JSONB's numeric output still marks this as a float.
  const mantissa = representation.slice(0, exponentIndex);
  const exponent = Number(representation.slice(exponentIndex + 1));
  const negative = mantissa.startsWith('-');
  const unsigned = negative ? mantissa.slice(1) : mantissa;
  const decimalIndex = unsigned.indexOf('.');
  const digits = unsigned.replace('.', '');
  const decimalPosition = (decimalIndex < 0 ? digits.length : decimalIndex) + exponent;
  const sign = negative ? '-' : '';
  if (decimalPosition <= 0)
    return `${sign}0.${'0'.repeat(-decimalPosition)}${digits}`;
  if (decimalPosition >= digits.length)
    return `${sign}${digits}${'0'.repeat(decimalPosition - digits.length)}.0`;
  return `${sign}${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
}
