import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';

export type JsonRecord = Record<string, any>;

export function parseTimestamp(value: string): Date {
  if (typeof value !== 'string')
    throw new BadRequestException('timestamp is invalid');
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
  const compact =
    /^(\d{4})(\d{2})(\d{2})([T ])(\d{2})(\d{2})(\d{2})?([.,]\d+)?(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(
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
    !/(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(normalized)
  )
    normalized += 'Z';
  validateTimestampFields(normalized);
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime()))
    throw new BadRequestException('timestamp is invalid');
  return date;
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
  const raw =
    value instanceof Date
      ? value.toISOString()
      : value.replace(/^(\d{4}(?:-\d{2}-\d{2}|\d{4}))t/i, '$1T');
  const date = parseTimestamp(raw);
  const fraction = /[T ]\d{2}:\d{2}:\d{2}[.,](\d+)/.exec(raw)?.[1] ?? '';
  const microseconds = fraction.slice(0, 6).padEnd(6, '0');
  const seconds = date.toISOString().slice(0, 19);
  return microseconds === '000000'
    ? `${seconds}Z`
    : `${seconds}.${microseconds}Z`;
}

export function normalizeCallsign(value: unknown): string {
  if (
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    typeof value !== 'boolean'
  ) {
    throw new BadRequestException('callsign is invalid');
  }
  const normalized = collapsePythonWhitespace(String(value).toUpperCase());
  if (
    !normalized ||
    normalized.length > 32 ||
    !/^[A-Z0-9/ -]+$/.test(normalized)
  ) {
    throw new BadRequestException('callsign is invalid');
  }
  return normalized;
}

function collapsePythonWhitespace(value: string): string {
  const output: string[] = [];
  let pendingSpace = false;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (isPythonWhitespace(codePoint)) {
      pendingSpace ||= output.length > 0;
      continue;
    }
    if (pendingSpace) output.push(' ');
    output.push(character);
    pendingSpace = false;
  }
  return output.join('');
}

function trimPythonWhitespace(value: string): string {
  const characters = Array.from(value);
  let start = 0;
  let end = characters.length;
  while (start < end && isPythonWhitespace(characters[start].codePointAt(0)!))
    start += 1;
  while (end > start && isPythonWhitespace(characters[end - 1].codePointAt(0)!))
    end -= 1;
  return characters.slice(start, end).join('');
}

function isPythonWhitespace(codePoint: number): boolean {
  return (
    (codePoint >= 0x09 && codePoint <= 0x0d) ||
    (codePoint >= 0x1c && codePoint <= 0x20) ||
    codePoint === 0x85 ||
    codePoint === 0xa0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000
  );
}

export function normalizeActivation(data: JsonRecord): JsonRecord {
  const programmeRules = data.programmeRules;
  const rules =
    programmeRules && Object.keys(programmeRules).length > 0
      ? programmeRules
      : (data.rules ?? {});
  const location = data.location ?? {};
  if (
    rules.requireLocation &&
    (location.latitude == null || location.longitude == null)
  ) {
    throw new BadRequestException(
      'programme rules require an activation location',
    );
  }
  if (!pointInBounds(location, rules.entityBounds)) {
    throw new BadRequestException(
      'activation location is outside the entity bounds',
    );
  }
  const callsign = data.operatorCallsign
    ? normalizeCallsign(data.operatorCallsign)
    : null;
  const authorized = (data.authorizedCallsigns ?? []).map(normalizeCallsign);
  if (callsign && authorized.length && !authorized.includes(callsign)) {
    throw new BadRequestException(
      'operator callsign is not authorized for this account',
    );
  }
  if (callsign && data.callsignLifecycleStatus === 'RETIRED') {
    throw new BadRequestException('retired callsigns cannot start activations');
  }
  if (
    callsign &&
    data.callsignLifecycleStatus != null &&
    data.callsignLifecycleStatus !== 'VERIFIED' &&
    !rules.allowUnverifiedCallsign
  ) {
    throw new BadRequestException(
      'a verified callsign is required by this programme',
    );
  }
  const startedAt = normalizeTimestamp(data.startedAt);
  if (
    rules.maxActivationHours != null &&
    pythonFloat(rules.maxActivationHours, 'maxActivationHours') <= 0
  ) {
    throw new BadRequestException('maxActivationHours must be positive');
  }
  return {
    ...data,
    operatorCallsign: callsign,
    programmeRules: rules,
    location,
    startedAt,
  };
}

function pointInBounds(
  location: JsonRecord | null | undefined,
  bounds: JsonRecord | null | undefined,
): boolean {
  if (!bounds || Object.keys(bounds).length === 0) return true;
  if (!location || location.latitude == null || location.longitude == null)
    return false;
  const latitude = pythonFloat(location.latitude, 'latitude');
  const longitude = pythonFloat(location.longitude, 'longitude');
  return (
    pythonFloat(bounds.minLatitude, 'minLatitude') <= latitude &&
    latitude <= pythonFloat(bounds.maxLatitude, 'maxLatitude') &&
    pythonFloat(bounds.minLongitude, 'minLongitude') <= longitude &&
    longitude <= pythonFloat(bounds.maxLongitude, 'maxLongitude')
  );
}

export function pythonFloat(value: unknown, field: string): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const text = typeof value === 'string' ? value.trim() : '';
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

function pythonInt(value: unknown, field: string): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (Number.isNaN(value))
      throw new BadRequestException(`cannot convert float NaN to integer`);
    if (!Number.isFinite(value))
      throw new RangeError('cannot convert float infinity to integer');
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!/^[+-]?\d(?:_?\d)*$/.test(normalized))
      throw new BadRequestException(`${field} must be an integer`);
    return Number(normalized.replaceAll('_', ''));
  }
  throw new TypeError(
    'int() argument must be a string, a real number, or a boolean',
  );
}

export function normalizeQso(
  data: JsonRecord,
  activationId: string,
): JsonRecord {
  const normalized = normalizeQsoFields(data);
  const { workedCallsign, timestamp, band, mode, workedStationKey } =
    normalized;
  const canonical = [
    activationId,
    workedCallsign,
    timestamp.replace(/Z$/, '+00:00'),
    band ?? '',
    mode ?? '',
    data.hunterId ?? '',
    data.workedEntityId ?? '',
  ].join('|');
  const deduplicationKey = createHash('sha256').update(canonical).digest('hex');
  return {
    ...normalized,
    id: randomUUID(),
    activationId,
    source: data.source ?? 'manual',
    workedStationKey,
    deduplicationKey,
  };
}

function normalizeQsoFields(data: JsonRecord): JsonRecord {
  const workedCallsign = normalizeCallsign(data.workedCallsign);
  const timestamp = normalizeTimestamp(data.timestamp || data.timeOn);
  const band = normalizeBand(data.band);
  const mode = normalizeMode(data.mode);
  const validBands = new Set([
    '2190M',
    '630M',
    '160M',
    '80M',
    '60M',
    '40M',
    '30M',
    '20M',
    '17M',
    '15M',
    '12M',
    '10M',
    '6M',
    '4M',
    '2M',
    '70CM',
    '23CM',
  ]);
  const validModes = new Set([
    'AM',
    'CW',
    'FM',
    'FT8',
    'FT4',
    'JS8',
    'RTTY',
    'SSB',
    'USB',
    'LSB',
    'DIGITAL',
    'PSK31',
    'SSTV',
    'DSTAR',
    'DMR',
    'C4FM',
  ]);
  if (band && !validBands.has(band))
    throw new BadRequestException(`unsupported band: ${data.band}`);
  if (mode && !validModes.has(mode))
    throw new BadRequestException(`unsupported mode: ${data.mode}`);
  if (data.band != null && data.band !== '' && !band)
    throw new BadRequestException(`unsupported band: ${data.band}`);
  if (data.mode != null && data.mode !== '' && !mode)
    throw new BadRequestException(`unsupported mode: ${data.mode}`);
  const workedStationKey = `${workedCallsign}|${String(data.workedLocator || '')
    .toUpperCase()
    .trim()}`;
  return {
    ...data,
    workedCallsign,
    timestamp,
    band,
    mode,
    workedStationKey,
  };
}

function normalizeBand(value: unknown): string | null {
  if (value == null || value === '') return null;
  return stringValue(value).toUpperCase().replaceAll(' ', '');
}

function normalizeMode(value: unknown): string | null {
  if (value == null || value === '') return null;
  return stringValue(value).toUpperCase().replaceAll('-', '');
}

function stringValue(value: unknown) {
  return typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
    ? String(value)
    : (JSON.stringify(value) ?? '');
}

export function parseAdif(text: string): JsonRecord[] {
  const records: JsonRecord[] = [];
  const fields = /<([^:>]+)(?::(\d+))?(?:[:][^>]*)?>(.*?)(?=<[^>]*>|$)/gis;
  const mapping: Record<string, string> = {
    CALL: 'workedCallsign',
    QSO_DATE_TIME: 'timestamp',
    QSO_DATE: 'date',
    TIME_ON: 'time',
    BAND: 'band',
    MODE: 'mode',
    RST_SENT: 'rst',
    RST_RCVD: 'rstReceived',
    STATION_CALLSIGN: 'operatorCallsign',
    MY_SIG_INFO: 'workedEntityId',
    SIG_INFO: 'workedEntityId',
    GRIDSQUARE: 'workedLocator',
  };
  let current: JsonRecord = {};
  for (const match of text.matchAll(fields)) {
    const name = trimPythonWhitespace(match[1].toUpperCase());
    const value = trimPythonWhitespace(
      (match[3] ?? '').slice(0, match[2] ? Number(match[2]) : undefined),
    );
    if (name === 'EOR') {
      if (Object.keys(current).length) records.push(current);
      current = {};
      continue;
    }
    const mapped = mapping[name];
    if (mapped) current[mapped] = value;
  }
  if (Object.keys(current).length) records.push(current);
  return records.flatMap((record) => {
    let timestamp = record.timestamp;
    if (!timestamp && record.date && record.time) {
      const date = String(record.date).replaceAll('/', '-');
      let time = String(record.time);
      if (
        /^(?:\d{8}|\d{4}-\d{2}-\d{2})$/.test(date) &&
        /^\d{4}(?:\d{2})?$/.test(time)
      ) {
        if (time.length === 4) time += '00';
        const normalizedDate =
          date.length === 8
            ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
            : date;
        timestamp = `${normalizedDate}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`;
      } else {
        timestamp = `${date}T${time}Z`;
      }
    }
    return record.workedCallsign && timestamp
      ? [normalizeQsoFields({ ...record, timestamp })]
      : [];
  });
}

export function evaluateActivation(
  activation: JsonRecord,
  qsos: JsonRecord[],
  endedAt: string,
): JsonRecord {
  const rules = activation.programmeRules ?? {};
  const violations: string[] = [];
  normalizeTimestamp(endedAt);
  if (compareTimestamps(endedAt, activation.startedAt) < 0)
    violations.push('endedAt must be after startedAt');
  if (
    activation.validityExpiresAt &&
    compareTimestamps(endedAt, activation.validityExpiresAt) > 0
  )
    violations.push('activation exceeded its validity window');
  if (
    rules.minimumQsos != null &&
    qsos.length < pythonInt(rules.minimumQsos, 'minimumQsos')
  )
    violations.push('minimum QSO requirement was not met');
  const bands = new Set(
    (rules.allowedBands ?? []).map((v: unknown) => String(v).toUpperCase()),
  );
  const modes = new Set(
    (rules.allowedModes ?? []).map((v: unknown) =>
      String(v).toUpperCase().replaceAll('-', ''),
    ),
  );
  for (const qso of qsos) {
    if (qso.band && bands.size && !bands.has(qso.band))
      violations.push(`band ${qso.band} is not allowed`);
    if (qso.mode && modes.size && !modes.has(qso.mode))
      violations.push(`mode ${qso.mode} is not allowed`);
  }
  return {
    valid: violations.length === 0,
    violations,
    evaluatedAt: normalizeTimestamp(new Date()),
    qsoCount: qsos.length,
    ruleVersion: rules.version ?? null,
  };
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
