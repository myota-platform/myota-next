import { BadRequestException } from '@nestjs/common';

/** Convert JSON values using the iterable semantics of Python's dict(). */
export function pythonDictionary(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (isRecord(value)) return { ...value };
  const iterable = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? Array.from(value)
      : undefined;
  if (iterable === undefined) throw new TypeError(`${field} is not iterable`);
  const entries: [string, unknown][] = [];
  for (const [index, item] of iterable.entries()) {
    const pair = dictionaryEntry(item, field);
    if (pair.length !== 2)
      throw new BadRequestException(
        `dictionary update sequence element #${index} has length ${pair.length}; 2 is required`,
      );
    const key = pair[0];
    if (key !== null && typeof key === 'object')
      throw new TypeError('unhashable type: object');
    entries.push([dictionaryKey(key), pair[1]]);
  }
  return Object.fromEntries(entries);
}

function dictionaryEntry(value: unknown, field: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return Array.from(value);
  if (isRecord(value)) return Object.keys(value);
  throw new TypeError(
    `dictionary update sequence element is not iterable for ${field}`,
  );
}

function dictionaryKey(value: unknown): string {
  if (value === null) return 'None';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint')
    return value.toString();
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  throw new TypeError('dictionary keys must be hashable');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
