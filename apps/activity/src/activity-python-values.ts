import { BadRequestException } from '@nestjs/common';
import { normalizePythonNumericText } from '@app/platform/python-numeric.js';

export function pythonFloat(value: unknown, field: string): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return Number(value);
  const text =
    typeof value === 'string' ? normalizePythonNumericText(value) : '';
  if (
    typeof value !== 'string' ||
    !/^[+-]?(?:(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:e[+-]?\d(?:_?\d)*)?|inf(?:inity)?|nan)$/i.test(
      text,
    )
  )
    throw new BadRequestException(`${field} must be numeric`);
  const normalized = text.replaceAll('_', '');
  const token = normalized.replace(/^[+-]/, '').toLowerCase();
  if (token === 'nan') return Number.NaN;
  if (token === 'inf' || token === 'infinity')
    return normalized.startsWith('-')
      ? Number.NEGATIVE_INFINITY
      : Number.POSITIVE_INFINITY;
  return Number(normalized);
}

export function pythonInt(value: unknown, field: string): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (Number.isNaN(value))
      throw new BadRequestException(`cannot convert float NaN to integer`);
    if (!Number.isFinite(value))
      throw new RangeError('cannot convert float infinity to integer');
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const normalized = normalizePythonNumericText(value);
    if (!/^[+-]?\d(?:_?\d)*$/.test(normalized))
      throw new BadRequestException(`${field} must be an integer`);
    return Number(normalized.replaceAll('_', ''));
  }
  throw new TypeError(
    'int() argument must be a string, a real number, or a boolean',
  );
}
