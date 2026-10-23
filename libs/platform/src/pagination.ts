import { BadRequestException } from '@nestjs/common';
import { firstQueryValue } from './query.js';
import { normalizePythonNumericText } from './python-numeric.js';

export type PageInteger = number | bigint;

export function parsePageTotal(value: unknown): PageInteger {
  let total: bigint;
  if (typeof value === 'bigint') total = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value))
    total = BigInt(value);
  else if (typeof value === 'string' && /^\d+$/.test(value))
    total = BigInt(value);
  else
    throw new TypeError('database page total must be a non-negative integer');

  if (total < 0n)
    throw new TypeError('database page total must be a non-negative integer');
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : total;
}

export function parsePageInteger(
  value: unknown,
  fallback: number,
  maximum: number,
): number;
export function parsePageInteger(value: unknown, fallback: number): PageInteger;
export function parsePageInteger(
  value: unknown,
  fallback: number,
  maximum?: number,
): PageInteger {
  const raw = Array.isArray(value) ? firstQueryValue(value) : value;
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string')
    throw new BadRequestException('page and pageSize must be integers');
  const normalized = normalizePythonNumericText(raw);
  if (!/^[+-]?\d(?:_?\d)*$/.test(normalized))
    throw new BadRequestException('page and pageSize must be integers');
  const parsedInteger = BigInt(normalized.replaceAll('_', ''));
  if (maximum !== undefined) {
    const minimumBounded = parsedInteger < 1n ? 1n : parsedInteger;
    const maximumBounded = BigInt(maximum);
    return Number(
      minimumBounded > maximumBounded ? maximumBounded : minimumBounded,
    );
  }
  if (parsedInteger > BigInt(Number.MAX_SAFE_INTEGER)) return parsedInteger;
  const parsed = Number(parsedInteger);
  return Math.max(1, parsed);
}

export function pageOffset(page: PageInteger, pageSize: number): PageInteger {
  const offset = (BigInt(page) - 1n) * BigInt(pageSize);
  return offset <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(offset) : offset;
}

export function nextPage(page: PageInteger): PageInteger {
  const next = BigInt(page) + 1n;
  return next <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(next) : next;
}

export function nextPageIfMore(
  page: PageInteger,
  pageSize: number,
  total: PageInteger,
): PageInteger | null {
  return BigInt(page) * BigInt(pageSize) < BigInt(total)
    ? nextPage(page)
    : null;
}
