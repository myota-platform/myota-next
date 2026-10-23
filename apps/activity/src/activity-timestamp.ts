import { BadRequestException } from '@nestjs/common';

export function parseTimestamp(value: string): Date {
  if (typeof value !== 'string' || value.endsWith('z'))
    throw new BadRequestException('timestamp is invalid');
  let normalized = normalizeTimestampInput(value);
  normalized = normalizeExtendedTimezoneOffset(normalized) ?? normalized;
  validateTimestampFields(normalized);
  const date = new Date(normalized);
  const utcYear = date.getUTCFullYear();
  if (!Number.isFinite(date.getTime()) || utcYear < 1 || utcYear > 9999)
    throw new BadRequestException('timestamp is invalid');
  return date;
}

function normalizeTimestampInput(value: string): string {
  let normalized = value
    .replace(/^(\d{4}(?:-\d{2}-\d{2}|\d{4}))t/i, '$1T')
    .replace(/([T ]\d{2}:\d{2}:\d{2}),(\d+)/, '$1.$2');
  const weekDate = /^(\d{4})-?W(\d{2})(?:-?([1-7]))?([Tt ].*)?$/i.exec(
    normalized,
  );
  if (weekDate) {
    const [, yearText, weekText, dayText, time] = weekDate;
    normalized = `${isoWeekDate(
      Number(yearText),
      Number(weekText),
      Number(dayText ?? 1),
    )}${time?.replace(/^t/, 'T') ?? ''}`;
  }
  const arbitraryTimeSeparator =
    /^(\d{4}(?:-\d{2}-\d{2}|\d{4}))([^0-9])(?=\d{2}:?\d{2})/u.exec(normalized);
  if (arbitraryTimeSeparator) {
    const [, date, separator] = arbitraryTimeSeparator;
    normalized = `${date}T${normalized.slice(date.length + separator.length)}`;
  }
  const compact =
    /^(\d{4})(\d{2})(\d{2})([T ])(\d{2})(\d{2})(\d{2})?([.,]\d+)?(Z|[+-]\d{2}(?::?\d{2})?(?::?\d{2}(?:[.,]\d+)?)?)?$/i.exec(
      normalized,
    );
  if (compact) {
    const [
      ,
      year,
      month,
      day,
      separator,
      hour,
      minute,
      second,
      fraction,
      zone,
    ] = compact;
    normalized = `${year}-${month}-${day}${separator}${hour}:${minute}${second ? `:${second}` : ''}${fraction?.replace(',', '.') ?? ''}${zone ?? ''}`;
  } else {
    const compactDate = /^(\d{4})(\d{2})(\d{2})$/.exec(normalized);
    if (compactDate)
      normalized = `${compactDate[1]}-${compactDate[2]}-${compactDate[3]}`;
  }
  if (/[T ]\d{2}:\d{2}/.test(normalized))
    normalized = normalized.replace(/([+-]\d{2})$/i, '$1:00');
  if (
    /[T ]\d{2}:\d{2}/.test(normalized) &&
    !/(?:Z|[+-]\d{2}(?::?\d{2})?(?::?\d{2}(?:[.,]\d+)?)?)$/i.test(normalized)
  )
    normalized += 'Z';
  return normalized;
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
  const offsetHours = Number(extendedHours ?? basicHours);
  const offsetMinutes = Number(extendedMinutes ?? basicMinutes);
  const offsetSeconds = Number(extendedSeconds ?? basicSeconds);
  if (offsetHours > 23 || offsetMinutes > 59 || offsetSeconds > 59)
    throw new BadRequestException('timestamp is invalid');

  const localTime = `${dateText}T${hourText}:${minuteText}:${secondText ?? '00'}${localFraction ? `.${localFraction}` : ''}Z`;
  validateTimestampFields(localTime);
  const [year, month, day] = dateText.split('-').map(Number);
  const localDate = new Date(0);
  localDate.setUTCFullYear(year, month - 1, day);
  localDate.setUTCHours(
    Number(hourText),
    Number(minuteText),
    Number(secondText ?? 0),
    0,
  );
  const localMicroseconds = Number(
    (localFraction ?? '').slice(0, 6).padEnd(6, '0'),
  );
  const offsetMicroseconds = Number(
    (offsetFraction ?? '').slice(0, 6).padEnd(6, '0'),
  );
  const offsetTotalMicroseconds =
    BigInt(offsetHours * 3600 + offsetMinutes * 60 + offsetSeconds) *
      1_000_000n +
    BigInt(offsetMicroseconds);
  const signedOffsetMicroseconds =
    sign === '+' ? offsetTotalMicroseconds : -offsetTotalMicroseconds;
  const utcMicroseconds =
    BigInt(localDate.getTime()) * 1000n +
    BigInt(localMicroseconds) -
    signedOffsetMicroseconds;
  let utcMilliseconds = utcMicroseconds / 1000n;
  let subMillisecondMicroseconds = utcMicroseconds % 1000n;
  if (subMillisecondMicroseconds < 0n) {
    utcMilliseconds--;
    subMillisecondMicroseconds += 1000n;
  }
  const utcDate = new Date(Number(utcMilliseconds));
  const utcYear = utcDate.getUTCFullYear();
  if (!Number.isFinite(utcDate.getTime()) || utcYear < 1 || utcYear > 9999)
    throw new BadRequestException('timestamp is invalid');
  const microseconds =
    utcDate.getUTCMilliseconds() * 1000 + Number(subMillisecondMicroseconds);
  const seconds = utcDate.toISOString().slice(0, 19);
  return microseconds === 0
    ? `${seconds}Z`
    : `${seconds}.${String(microseconds).padStart(6, '0')}Z`;
}

function isoWeekDate(year: number, week: number, day: number): string {
  if (year < 1 || week < 1 || week > 53 || day < 1 || day > 7)
    throw new BadRequestException('timestamp is invalid');
  const januaryFirst = new Date(0);
  januaryFirst.setUTCFullYear(year, 0, 1);
  januaryFirst.setUTCHours(0, 0, 0, 0);
  const januaryFirstWeekday = (januaryFirst.getUTCDay() + 6) % 7;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maximumWeek =
    januaryFirstWeekday === 3 || (januaryFirstWeekday === 2 && leapYear)
      ? 53
      : 52;
  if (week > maximumWeek) throw new BadRequestException('timestamp is invalid');

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
  const calendarYear = januaryFourth.getUTCFullYear();
  if (calendarYear > 9999)
    throw new BadRequestException('timestamp is invalid');
  return januaryFourth.toISOString().slice(0, 10);
}

function validateTimestampFields(value: string) {
  const fields =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?(?:Z|([+-])(\d{2}):?(\d{2})?)?)?$/i.exec(
      value,
    );
  if (!fields) throw new BadRequestException('timestamp is invalid');
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    ,
    offsetHours,
    offsetMinutes,
  ] = fields;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > monthDays[month - 1]
  )
    throw new BadRequestException('timestamp is invalid');

  if (hourText !== undefined) {
    if (
      Number(hourText) > 23 ||
      Number(minuteText) > 59 ||
      (secondText !== undefined && Number(secondText) > 59)
    )
      throw new BadRequestException('timestamp is invalid');
    if (
      offsetHours !== undefined &&
      (Number(offsetHours) > 23 || Number(offsetMinutes ?? 0) > 59)
    )
      throw new BadRequestException('timestamp is invalid');
  }
}

export function normalizeTimestamp(value: string | Date): string {
  if (!(value instanceof Date) && typeof value !== 'string')
    throw new BadRequestException('timestamp is invalid');
  const raw = value instanceof Date ? value.toISOString() : value;
  const normalized = normalizeTimestampInput(raw);
  const extendedOffset = normalizeExtendedTimezoneOffset(normalized);
  if (extendedOffset) return extendedOffset;
  const date = parseTimestamp(raw);
  const fraction = /[T ]\d{2}:\d{2}:\d{2}[.,](\d+)/.exec(normalized)?.[1] ?? '';
  const microseconds = fraction.slice(0, 6).padEnd(6, '0');
  const seconds = date.toISOString().slice(0, 19);
  return microseconds === '000000'
    ? `${seconds}Z`
    : `${seconds}.${microseconds}Z`;
}

export function compareTimestamps(left: string | Date, right: string | Date) {
  const orderKey = (value: string | Date) => {
    const timestamp = normalizeTimestamp(value);
    return timestamp.includes('.')
      ? timestamp
      : timestamp.replace(/Z$/, '.000000Z');
  };
  const leftKey = orderKey(left);
  const rightKey = orderKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}
