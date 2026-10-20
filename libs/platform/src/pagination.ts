import { BadRequestException } from '@nestjs/common';
import { firstQueryValue } from './query.js';

export function parsePageInteger(value: unknown, fallback: number): number {
  const raw = Array.isArray(value) ? firstQueryValue(value) : value;
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string')
    throw new BadRequestException('page and pageSize must be integers');
  const normalized = raw.trim();
  if (!/^[+-]?\d(?:_?\d)*$/.test(normalized))
    throw new BadRequestException('page and pageSize must be integers');
  const parsed = Number(normalized.replaceAll('_', ''));
  if (!Number.isSafeInteger(parsed))
    throw new BadRequestException('page and pageSize must be integers');
  return Math.max(1, parsed);
}
