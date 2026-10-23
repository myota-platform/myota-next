import { unicodeCaseFold } from '@app/platform/unicode-casefold.js';
import { pythonCollapseWhitespace } from '@app/platform/python-string.js';

const aliases = [
  'name',
  'official_name',
  'site_name',
  'park_name',
  'reserve_name',
  'trail_name',
  'local_name',
  'nombre',
  'denominacion',
  'designation',
  'title',
  'label',
];
const nameTokens = ['name', 'nombre', 'denom', 'designation', 'title', 'label'];
const excludedTokens = [
  'code',
  'id',
  'type',
  'area',
  'hect',
  'lat',
  'lon',
  'lng',
  'region',
  'country',
  'province',
  'county',
  'municip',
  'city',
  'state',
  'admin',
  'source',
  'ref',
  'url',
  'license',
];
const emptyNames = new Set([
  '',
  '-',
  '--',
  'n/a',
  'na',
  'none',
  'null',
  'unknown',
  'unnamed',
]);

export function inferFeatureName(
  properties: Record<string, unknown>,
): string | null {
  const pairs = Object.entries(properties);
  const tags = properties.tags;
  if (isRecord(tags)) pairs.push(...Object.entries(tags));

  const byKey = new Map<string, unknown[]>();
  for (const [key, value] of pairs) {
    const normalized = normalizeKey(key);
    byKey.set(normalized, [...(byKey.get(normalized) ?? []), value]);
  }
  for (const alias of aliases) {
    for (const value of byKey.get(normalizeKey(alias)) ?? []) {
      const candidate = nameValue(value);
      if (candidate) return candidate;
    }
  }
  for (const [key, value] of pairs) {
    const normalized = normalizeKey(key);
    if (!nameTokens.some((token) => normalized.includes(token))) continue;
    if (excludedTokens.some((token) => normalized.includes(token))) continue;
    const candidate = nameValue(value);
    if (candidate) return candidate;
  }
  return null;
}

function normalizeKey(value: string): string {
  return unicodeCaseFold(value).replace(/[^a-z0-9]+/g, '');
}

function nameValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = pythonCollapseWhitespace(value);
  return emptyNames.has(unicodeCaseFold(cleaned))
    ? null
    : Array.from(cleaned).slice(0, 300).join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
