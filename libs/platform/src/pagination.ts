import { BadRequestException } from '@nestjs/common';
import { firstQueryValue } from './query.js';
import { normalizePythonNumericText } from './python-numeric.js';

export type PageInteger = number | bigint;

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

export function pageOffset(page: PageInteger, pageSize: number): number {
  const offset = (BigInt(page) - 1n) * BigInt(pageSize);
  return Number(
    offset > BigInt(Number.MAX_SAFE_INTEGER)
      ? BigInt(Number.MAX_SAFE_INTEGER)
      : offset,
  );
}

export function nextPage(page: PageInteger): PageInteger {
  const next = BigInt(page) + 1n;
  return next <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(next) : next;
}

export function nextPageIfMore(
  page: PageInteger,
  pageSize: number,
  total: number,
): PageInteger | null {
  return BigInt(page) * BigInt(pageSize) < BigInt(total)
    ? nextPage(page)
    : null;
}
