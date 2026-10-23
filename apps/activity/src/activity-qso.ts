import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { normalizeTimestamp } from './activity-timestamp.js';
import { normalizeCallsign } from './activity-activation.js';
import { normalizePythonNumericText } from '@app/platform/python-numeric.js';
import { pythonTruthy } from '@app/platform/python-truthiness.js';
import {
  pythonStringJsonField,
  trimPythonWhitespace,
} from '@app/platform/python-strings.js';
import type { JsonRecord } from './activity-types.js';

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
