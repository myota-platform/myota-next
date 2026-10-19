import { BadRequestException } from '@nestjs/common';

export function isTruthyJsonValue(value: unknown): boolean {
  if (value == null || value === false || value === '' || value === 0) {
    return false;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

export function normalizeUtcTimestamp(value: string): string {
  let normalized = value.replace(/([Tt ]\d{2}:\d{2}:\d{2}),(?=\d)/, '$1.');
  normalized = normalized.replace(/[t ]/, 'T');
  normalized = normalized.replace(
    /(\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})(\d{2})?$/,
    (_match, time: string, hours: string, minutes?: string) =>
      `${time}${hours}:${minutes ?? '00'}`,
  );
  if (/^\d{8}$/.test(normalized))
    normalized = `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}-${normalized.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    normalized += 'T00:00:00';
  }
  const dateParts = /^(\d{4})-(\d{2})-(\d{2})/.exec(normalized);
  if (dateParts) {
    const year = Number(dateParts[1]);
    const month = Number(dateParts[2]);
    const day = Number(dateParts[3]);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth)
      throw new BadRequestException('effectiveFrom must be a valid timestamp');
  }
  const hasTimezone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized);
  const timestamp = hasTimezone ? normalized : `${normalized}Z`;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    throw new BadRequestException('effectiveFrom must be a valid timestamp');
  }
  const fraction = /T\d{2}:\d{2}:\d{2}\.(\d+)/i.exec(timestamp)?.[1];
  const microseconds = (fraction ?? '').padEnd(6, '0').slice(0, 6);
  const utcSeconds = date.toISOString().slice(0, 19);
  return microseconds === '000000'
    ? `${utcSeconds}Z`
    : `${utcSeconds}.${microseconds}Z`;
}
