import { BadRequestException } from '@nestjs/common';
import { firstQueryValue } from './query.js';
import { normalizePythonNumericText } from './python-numeric.js';

export function parsePageInteger(
  value: unknown,
  fallback: number,
  maximum?: number,
): number {
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
  const parsed = Number(parsedInteger);
  if (!Number.isSafeInteger(parsed))
    throw new BadRequestException('page and pageSize must be integers');
  return Math.max(1, parsed);
}
