import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';

export type JsonRecord = Record<string, any>;

export function parseTimestamp(value: string): Date {
  if (typeof value !== 'string')
    throw new BadRequestException('timestamp is invalid');
  let normalized = value.replace(/([T ]\d{2}:\d{2}:\d{2}),(\d+)/, '$1.$2');
  if (
    /[T ]\d{2}:\d{2}/.test(normalized) &&
    !/(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(normalized)
  )
    normalized += 'Z';
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime()))
    throw new BadRequestException('timestamp is invalid');
  return date;
}

export function normalizeTimestamp(value: string | Date): string {
  if (!(value instanceof Date) && typeof value !== 'string')
    throw new BadRequestException('timestamp is invalid');
  const raw = value instanceof Date ? value.toISOString() : value;
  const date = parseTimestamp(raw);
  const fraction = /[T ]\d{2}:\d{2}:\d{2}[.,](\d+)/.exec(raw)?.[1] ?? '';
  const microseconds = fraction.slice(0, 6).padEnd(6, '0');
  const seconds = date.toISOString().slice(0, 19);
  return microseconds === '000000'
    ? `${seconds}Z`
    : `${seconds}.${microseconds}Z`;
}

export function normalizeCallsign(value: unknown): string {
  if (typeof value !== 'string') {
    throw new BadRequestException('callsign is invalid');
  }
  const normalized = value.toUpperCase().trim().replace(/\s+/g, ' ');
  if (
    !normalized ||
    normalized.length > 32 ||
    !/^[A-Z0-9/ -]+$/.test(normalized)
  ) {
    throw new BadRequestException('callsign is invalid');
  }
  return normalized;
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
    Number(rules.maxActivationHours) <= 0
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
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  return (
    Number(bounds.minLatitude) <= latitude &&
    latitude <= Number(bounds.maxLatitude) &&
    Number(bounds.minLongitude) <= longitude &&
    longitude <= Number(bounds.maxLongitude)
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
    const name = match[1].toUpperCase().trim();
    const value = (match[3] ?? '')
      .slice(0, match[2] ? Number(match[2]) : undefined)
      .trim();
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
      if (/^\d{8}$/.test(date) && /^\d{4}(?:\d{2})?$/.test(time)) {
        if (time.length === 4) time += '00';
        timestamp = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`;
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
  if (rules.minimumQsos != null && qsos.length < Number(rules.minimumQsos))
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
    evaluatedAt: new Date().toISOString(),
    qsoCount: qsos.length,
    ruleVersion: rules.version,
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
