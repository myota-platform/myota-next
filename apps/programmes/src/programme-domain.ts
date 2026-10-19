import { BadRequestException } from '@nestjs/common';

export function normalizeUtcTimestamp(value: string): string {
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const normalized = hasTimezone
    ? value
    : value.includes('T')
      ? `${value}Z`
      : `${value}T00:00:00Z`;
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) {
    throw new BadRequestException('effectiveFrom must be a valid timestamp');
  }
  const fraction = /T\d{2}:\d{2}:\d{2}\.(\d+)/i.exec(normalized)?.[1];
  const microseconds = (fraction ?? '').padEnd(6, '0').slice(0, 6);
  const utcSeconds = date.toISOString().slice(0, 19);
  return microseconds === '000000'
    ? `${utcSeconds}Z`
    : `${utcSeconds}.${microseconds}Z`;
}
