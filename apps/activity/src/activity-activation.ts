import { BadRequestException, NotFoundException } from '@nestjs/common';
import { normalizeTimestamp, compareTimestamps } from './activity-timestamp.js';
import { pythonFloat, pythonInt } from './activity-python-values.js';
import { pythonDictionary } from '@app/platform/python-dictionary.js';
import { pythonTruthy } from '@app/platform/python-truthiness.js';
import {
  collapsePythonWhitespace,
  pythonStringJsonField,
} from '@app/platform/python-strings.js';
import type { JsonRecord } from './activity-types.js';

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
