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
  let normalized = value.replace(
    /((?:[Tt ]\d{2}:\d{2}:\d{2})|(?:[Tt ]\d{6})),(?=\d)/,
    '$1.',
  );
  normalized = normalized.replace(/[t ]/, 'T');
  const weekDate = /^(\d{4})-?W(\d{2})(?:-?([1-7]))?(?:([^0-9])(.+))?$/iu.exec(
    normalized,
  );
  if (weekDate) {
    const [, yearText, weekText, dayText, _separator, time] = weekDate;
    normalized = `${isoWeekDate(
      Number(yearText),
      Number(weekText),
      Number(dayText ?? 1),
    )}${time ? `T${time}` : ''}`;
  }
  const arbitraryTimeSeparator =
    /^(\d{4}(?:-\d{2}-\d{2}|\d{4}))([^0-9])(?=\d{2}:?\d{2})/u.exec(normalized);
  if (arbitraryTimeSeparator) {
    const [, date, separator] = arbitraryTimeSeparator;
    normalized = `${date}T${normalized.slice(date.length + separator.length)}`;
  }
  const compactDateTime =
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})?(\d{2})?(.*)$/.exec(normalized);
  if (compactDateTime) {
    const [, year, month, day, hour, minute, second, suffix] = compactDateTime;
    normalized = `${year}-${month}-${day}T${hour}${minute ? `:${minute}` : ''}${second ? `:${second}` : ''}${suffix}`;
  } else {
    const compactTime =
      /^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})?(\d{2})?(.*)$/.exec(normalized);
    if (compactTime) {
      const [, date, hour, minute, second, suffix] = compactTime;
      normalized = `${date}T${hour}${minute ? `:${minute}` : ''}${second ? `:${second}` : ''}${suffix}`;
    }
  }
  if (normalized.includes('T'))
    normalized = normalized.replace(
      /([+-])(\d{2})(?::?(\d{2}))$/,
      (_match, sign: string, hours: string, minutes?: string) =>
        `${sign}${hours}:${minutes ?? '00'}`,
    );
  normalized = normalized.replace(
    /T(\d{2}:\d{2})(?=(?:Z|[+-]\d{2}(?::?\d{2})?(?::?\d{2}(?:[.,]\d+)?)?)?$)/i,
    '$1:00',
  );
  normalized = normalized.replace(
    /T(\d{2})(?=(?:Z|[+-]\d{2}(?::?\d{2})?(?::?\d{2}(?:[.,]\d+)?)?)?$)/i,
    '$1:00:00',
  );
  const extendedOffset = normalizeExtendedTimezoneOffset(normalized);
  if (extendedOffset) return extendedOffset;
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
    const monthEnd = new Date(0);
    monthEnd.setUTCFullYear(year, month, 0);
    const daysInMonth = monthEnd.getUTCDate();
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

function normalizeExtendedTimezoneOffset(value: string): string | undefined {
  const offset =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?([+-])(?:(\d{2}):(\d{2}):(\d{2})|(\d{2})(\d{2})(\d{2}))(?:[.,](\d+))?$/.exec(
      value,
    );
  if (!offset) return undefined;

  const [
    ,
    dateText,
    hourText,
    minuteText,
    secondText,
    localFraction,
    sign,
    extendedHours,
    extendedMinutes,
    extendedSeconds,
    basicHours,
    basicMinutes,
    basicSeconds,
    offsetFraction,
  ] = offset;
  const [year, month, day] = dateText.split('-').map(Number);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText ?? 0);
  const offsetHours = Number(extendedHours ?? basicHours);
  const offsetMinutes = Number(extendedMinutes ?? basicMinutes);
  const offsetSeconds = Number(extendedSeconds ?? basicSeconds);
  if (
    year < 1 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHours > 23 ||
    offsetMinutes > 59 ||
    offsetSeconds > 59
  )
    throw new BadRequestException('effectiveFrom must be a valid timestamp');

  const localDate = new Date(0);
  localDate.setUTCFullYear(year, month - 1, day);
  localDate.setUTCHours(hour, minute, second, 0);
  if (
    localDate.getUTCFullYear() !== year ||
    localDate.getUTCMonth() + 1 !== month ||
    localDate.getUTCDate() !== day
  )
    throw new BadRequestException('effectiveFrom must be a valid timestamp');

  const localMicroseconds = BigInt(
    (localFraction ?? '').slice(0, 6).padEnd(6, '0') || '0',
  );
  const offsetMicroseconds =
    BigInt(offsetHours * 3600 + offsetMinutes * 60 + offsetSeconds) *
      1_000_000n +
    BigInt((offsetFraction ?? '').slice(0, 6).padEnd(6, '0') || '0');
  const localInstant = BigInt(localDate.getTime()) * 1000n + localMicroseconds;
  const utcMicroseconds =
    sign === '+'
      ? localInstant - offsetMicroseconds
      : localInstant + offsetMicroseconds;
  let utcMilliseconds = utcMicroseconds / 1000n;
  let subMillisecondMicroseconds = utcMicroseconds % 1000n;
  if (subMillisecondMicroseconds < 0n) {
    utcMilliseconds--;
    subMillisecondMicroseconds += 1000n;
  }
  const utcDate = new Date(Number(utcMilliseconds));
  const utcYear = utcDate.getUTCFullYear();
  if (!Number.isFinite(utcDate.getTime()) || utcYear < 1 || utcYear > 9999)
    throw new BadRequestException('effectiveFrom must be a valid timestamp');
  const microseconds =
    BigInt(utcDate.getUTCMilliseconds() * 1000) + subMillisecondMicroseconds;
  const utcSeconds = utcDate.toISOString().slice(0, 19);
  return microseconds === 0n
    ? `${utcSeconds}Z`
    : `${utcSeconds}.${microseconds.toString().padStart(6, '0')}Z`;
}

function isoWeekDate(year: number, week: number, day: number): string {
  if (year < 1 || week < 1 || week > 53 || day < 1 || day > 7)
    throw new BadRequestException('effectiveFrom must be a valid timestamp');
  const januaryFirst = new Date(0);
  januaryFirst.setUTCFullYear(year, 0, 1);
  januaryFirst.setUTCHours(0, 0, 0, 0);
  const januaryFirstWeekday = (januaryFirst.getUTCDay() + 6) % 7;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maximumWeek =
    januaryFirstWeekday === 3 || (januaryFirstWeekday === 2 && leapYear)
      ? 53
      : 52;
  if (week > maximumWeek)
    throw new BadRequestException('effectiveFrom must be a valid timestamp');

  const januaryFourth = new Date(0);
  januaryFourth.setUTCFullYear(year, 0, 4);
  januaryFourth.setUTCHours(0, 0, 0, 0);
  const januaryFourthWeekday = (januaryFourth.getUTCDay() + 6) % 7;
  januaryFourth.setUTCDate(
    januaryFourth.getUTCDate() -
      januaryFourthWeekday +
      (week - 1) * 7 +
      day -
      1,
  );
  if (januaryFourth.getUTCFullYear() > 9999)
    throw new BadRequestException('effectiveFrom must be a valid timestamp');
  return januaryFourth.toISOString().slice(0, 10);
}
