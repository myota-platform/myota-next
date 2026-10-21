import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { normalizeTimestamp, compareTimestamps } from './activity-timestamp.js';
import { pythonFloat, pythonInt } from './activity-python-values.js';
import { normalizePythonNumericText } from '@app/platform/python-numeric.js';
import { pythonDictionary } from '@app/platform/python-dictionary.js';
import { pythonTruthy } from '@app/platform/python-truthiness.js';
import {
  collapsePythonWhitespace,
  pythonStringJsonField,
  trimPythonWhitespace,
} from '@app/platform/python-strings.js';
export {
  parseTimestamp,
  normalizeTimestamp,
  compareTimestamps,
} from './activity-timestamp.js';
export { pythonFloat, pythonInt } from './activity-python-values.js';

export type JsonRecord = Record<string, any>;

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

export function normalizeActivation(data: JsonRecord): JsonRecord {
  const programmeRules = data.programmeRules;
  const rules = pythonDictionary(
    pythonTruthy(programmeRules)
      ? programmeRules
      : pythonTruthy(data.rules)
        ? data.rules
        : {},
    'programmeRules',
  ) as JsonRecord;
  const location = pythonDictionary(
    pythonTruthy(data.location) ? data.location : {},
    'location',
  ) as JsonRecord;
  if (
    pythonTruthy(rules.requireLocation) &&
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
  const rawCallsign = Object.hasOwn(data, 'operatorCallsign')
    ? data.operatorCallsign
    : null;
  const callsign = pythonTruthy(rawCallsign)
    ? normalizeCallsign(pythonStringJsonField(data, 'operatorCallsign'))
    : rawCallsign;
  const authorizedCallsigns = Object.hasOwn(data, 'authorizedCallsigns')
    ? pythonIterable(data.authorizedCallsigns, 'authorizedCallsigns')
    : [];
  const authorized = authorizedCallsigns.map((value, index) =>
    normalizeCallsign(
      Array.isArray(data.authorizedCallsigns)
        ? pythonStringJsonField(
            data.authorizedCallsigns as unknown as Record<string, unknown>,
            String(index),
          )
        : value,
    ),
  );
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
    !pythonTruthy(rules.allowUnverifiedCallsign)
  ) {
    throw new BadRequestException(
      'a verified callsign is required by this programme',
    );
  }
  if (!Object.hasOwn(data, 'startedAt'))
    throw new NotFoundException("'startedAt'");
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

function pythonIterable(value: unknown, field: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return Array.from(value);
  if (value !== null && typeof value === 'object') return Object.keys(value);
  throw new TypeError(`${field} is not iterable`);
}

function pythonScalarString(value: unknown): string {
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'string' || typeof value === 'number')
    return String(value);
  return JSON.stringify(value) ?? 'None';
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
    pythonTruthy(data.hunterId) ? pythonStringJsonField(data, 'hunterId') : '',
    pythonTruthy(data.workedEntityId)
      ? pythonStringJsonField(data, 'workedEntityId')
      : '',
  ].join('|');
  const deduplicationKey = createHash('sha256').update(canonical).digest('hex');
  return {
    ...normalized,
    id: randomUUID(),
    activationId,
    source: Object.hasOwn(data, 'source') ? data.source : 'manual',
    workedStationKey,
    deduplicationKey,
  };
}

function normalizeQsoFields(data: JsonRecord): JsonRecord {
  const workedCallsign = normalizeCallsign(
    Object.hasOwn(data, 'workedCallsign')
      ? pythonStringJsonField(data, 'workedCallsign')
      : data.workedCallsign,
  );
  const timestamp = normalizeTimestamp(
    pythonTruthy(data.timestamp) ? data.timestamp : data.timeOn,
  );
  const band = normalizeBand(data);
  const mode = normalizeMode(data);
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
    throw new BadRequestException(
      `unsupported band: ${pythonStringJsonField(data, 'band')}`,
    );
  if (mode && !validModes.has(mode))
    throw new BadRequestException(
      `unsupported mode: ${pythonStringJsonField(data, 'mode')}`,
    );
  if (data.band != null && data.band !== '' && !band)
    throw new BadRequestException(
      `unsupported band: ${pythonStringJsonField(data, 'band')}`,
    );
  if (data.mode != null && data.mode !== '' && !mode)
    throw new BadRequestException(
      `unsupported mode: ${pythonStringJsonField(data, 'mode')}`,
    );
  const workedStationKey = `${workedCallsign}|${trimPythonWhitespace(
    pythonTruthy(data.workedLocator)
      ? pythonStringJsonField(data, 'workedLocator').toUpperCase()
      : '',
  )}`;
  return {
    ...data,
    workedCallsign,
    timestamp,
    band,
    mode,
    workedStationKey,
  };
}

function normalizeBand(record: JsonRecord): string | null {
  const value = record.band;
  if (value == null || value === '') return null;
  return pythonStringJsonField(record, 'band')
    .toUpperCase()
    .replaceAll(' ', '');
}

function normalizeMode(record: JsonRecord): string | null {
  const value = record.mode;
  if (value == null || value === '') return null;
  return pythonStringJsonField(record, 'mode')
    .toUpperCase()
    .replaceAll('-', '');
}

export function parseAdif(text: string): JsonRecord[] {
  const records: JsonRecord[] = [];
  const fields =
    /<([^:>]+)(?::(\p{Decimal_Number}+))?(?:[:][^>]*)?>(.*?)(?=<[^>]*>|$)/gisu;
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
      sliceAdifValue(match[3] ?? '', match[2]),
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

function sliceAdifValue(value: string, lengthText?: string): string {
  if (lengthText === undefined) return value;
  const length = BigInt(normalizePythonNumericText(lengthText));
  if (length >= BigInt(value.length)) return value;
  return Array.from(value).slice(0, Number(length)).join('');
}

export function calculateAdifRejectedRecords(
  recordsSeen: number,
  recordsAccepted: number,
  normalizationErrorCount: number,
): number {
  // Preserve the Python worker's persisted counter, including its additional
  // normalization-error count on top of all non-accepted records.
  return recordsSeen - recordsAccepted + normalizationErrorCount;
}

export function adifAwardRecalculationKey(
  activationId: string,
  firstQsoDeduplicationKey: string,
): string {
  return `batch:${activationId}:${firstQsoDeduplicationKey}`;
}

export function evaluateActivation(
  activation: JsonRecord,
  qsos: JsonRecord[],
  endedAt: unknown,
  evaluatedAt = normalizeTimestamp(new Date()),
): JsonRecord {
  const rules = pythonTruthy(activation.programmeRules)
    ? activation.programmeRules
    : {};
  const violations: string[] = [];
  const normalizedEndedAt = pythonTruthy(endedAt)
    ? normalizeTimestamp(endedAt as string)
    : null;
  if (
    normalizedEndedAt &&
    compareTimestamps(normalizedEndedAt, activation.startedAt) < 0
  )
    violations.push('endedAt must be after startedAt');
  if (
    activation.validityExpiresAt &&
    normalizedEndedAt &&
    compareTimestamps(normalizedEndedAt, activation.validityExpiresAt) > 0
  )
    violations.push('activation exceeded its validity window');
  const minimumQsoRule = rules.minimumQsos;
  const minimumActivationQsos =
    minimumQsoRule !== null &&
    typeof minimumQsoRule === 'object' &&
    !Array.isArray(minimumQsoRule)
      ? (minimumQsoRule as Record<string, unknown>).activation
      : minimumQsoRule;
  if (
    minimumActivationQsos != null &&
    qsos.length < pythonInt(minimumActivationQsos, 'minimumQsos')
  )
    violations.push('minimum QSO requirement was not met');
  const allowedBands = Object.hasOwn(rules, 'allowedBands')
    ? pythonIterable(rules.allowedBands, 'allowedBands')
    : [];
  const allowedModes = Object.hasOwn(rules, 'allowedModes')
    ? pythonIterable(rules.allowedModes, 'allowedModes')
    : [];
  const bands = new Set(
    allowedBands.map((v: unknown) => pythonScalarString(v).toUpperCase()),
  );
  const modes = new Set(
    allowedModes.map((v: unknown) =>
      pythonScalarString(v).toUpperCase().replaceAll('-', ''),
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
    evaluatedAt,
    qsoCount: qsos.length,
    ruleVersion: rules.version ?? null,
  };
}
