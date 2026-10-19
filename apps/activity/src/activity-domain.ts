import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';

export type JsonRecord = Record<string, any>;

export function parseTimestamp(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new BadRequestException('timestamp is invalid');
  return date;
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
  const rules = data.programmeRules ?? data.rules ?? {};
  const location = data.location ?? {};
  if (
    rules.requireLocation &&
    (location.latitude == null || location.longitude == null)
  ) {
    throw new BadRequestException(
      'programme rules require an activation location',
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
    data.callsignLifecycleStatus &&
    data.callsignLifecycleStatus !== 'VERIFIED' &&
    !rules.allowUnverifiedCallsign
  ) {
    throw new BadRequestException(
      'a verified callsign is required by this programme',
    );
  }
  const startedAt = parseTimestamp(data.startedAt).toISOString();
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

export function normalizeQso(
  data: JsonRecord,
  activationId: string,
): JsonRecord {
  const workedCallsign = normalizeCallsign(data.workedCallsign);
  const timestamp = parseTimestamp(data.timestamp ?? data.timeOn).toISOString();
  const band = data.band
    ? String(data.band).toUpperCase().replaceAll(' ', '')
    : null;
  const mode = data.mode
    ? String(data.mode).toUpperCase().replaceAll('-', '')
    : null;
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
  const workedStationKey = `${workedCallsign}|${String(data.workedLocator ?? '')
    .toUpperCase()
    .trim()}`;
  const canonical = [
    activationId,
    workedCallsign,
    new Date(timestamp).toISOString(),
    band ?? '',
    mode ?? '',
    data.hunterId ?? '',
    data.workedEntityId ?? '',
  ].join('|');
  const deduplicationKey = createHash('sha256').update(canonical).digest('hex');
  return {
    ...data,
    id: randomUUID(),
    activationId,
    workedCallsign,
    timestamp,
    band,
    mode,
    source: data.source ?? 'manual',
    workedStationKey,
    deduplicationKey,
  };
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
    return record.workedCallsign && timestamp ? [{ ...record, timestamp }] : [];
  });
}

export function evaluateActivation(
  activation: JsonRecord,
  qsos: JsonRecord[],
  endedAt: string,
): JsonRecord {
  const rules = activation.programmeRules ?? {};
  const violations: string[] = [];
  const start = parseTimestamp(activation.startedAt);
  const end = parseTimestamp(endedAt);
  if (end < start) violations.push('endedAt must be after startedAt');
  if (
    activation.validityExpiresAt &&
    end > parseTimestamp(activation.validityExpiresAt)
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
