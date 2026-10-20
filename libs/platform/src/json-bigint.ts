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
  const ancestors = new Set<object>();
  const serialize = (item: unknown, key: string): string | undefined => {
    if (
      item !== null &&
      (typeof item === 'object' || typeof item === 'function') &&
      typeof (item as { toJSON?: unknown }).toJSON === 'function'
    )
      item = (item as { toJSON: (key: string) => unknown }).toJSON(key);

    if (item === null) return 'null';
    if (typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'boolean') return item ? 'true' : 'false';
    if (typeof item === 'number')
      return Number.isFinite(item) ? JSON.stringify(item) : 'null';
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
          (_, index) => serialize(item[index], String(index)) ?? 'null',
        ).join(',')}]`;
      const entries: string[] = [];
      for (const property of Object.keys(item)) {
        const encoded = serialize(
          (item as Record<string, unknown>)[property],
          property,
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
