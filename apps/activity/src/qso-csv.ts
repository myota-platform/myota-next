import { BadRequestException } from '@nestjs/common';
import type { JsonRecord } from './activity-domain.js';

const COLUMN_NAMES: Record<string, string> = {
  workedcallsign: 'workedCallsign',
  worked_callsign: 'workedCallsign',
  timestamp: 'timestamp',
  time_on: 'timestamp',
  timeon: 'timestamp',
  band: 'band',
  mode: 'mode',
  rst: 'rst',
  huntercallsign: 'hunterCallsign',
  hunter_callsign: 'hunterCallsign',
  hunterid: 'hunterId',
  hunter_id: 'hunterId',
  workedentityid: 'workedEntityId',
  worked_entity_id: 'workedEntityId',
  workedlocator: 'workedLocator',
  worked_locator: 'workedLocator',
};

export function parseQsoCsv(text: string, maximum: number): JsonRecord[] {
  const rows = parseRows(text);
  while (rows.at(-1)?.length === 1 && rows.at(-1)?.[0] === '') rows.pop();
  const header = rows.shift()?.map((value) => value.trim().toLowerCase());
  if (!header?.length || header.every((value) => !value))
    throw new BadRequestException('CSV header row is required');

  const columns = header.map((value) => COLUMN_NAMES[value]);
  if (columns.some((value) => !value))
    throw new BadRequestException('CSV contains an unsupported column');
  if (new Set(columns).size !== columns.length)
    throw new BadRequestException('CSV contains duplicate columns');
  if (!columns.includes('workedCallsign') || !columns.includes('timestamp'))
    throw new BadRequestException(
      'CSV must include workedCallsign and timestamp columns',
    );

  const records: JsonRecord[] = [];
  for (const [index, row] of rows.entries()) {
    if (row.length === 1 && row[0] === '') continue;
    if (row.length !== columns.length)
      throw new BadRequestException(
        `CSV row ${index + 2} has the wrong number of columns`,
      );
    const record: JsonRecord = {};
    columns.forEach((column, position) => {
      const value = row[position].trim();
      if (value) record[column] = value;
    });
    if (!record.workedCallsign || !record.timestamp)
      throw new BadRequestException(
        `CSV row ${index + 2} requires workedCallsign and timestamp`,
      );
    records.push(record);
    if (records.length > maximum)
      throw new BadRequestException(
        'QSO ingestion exceeds the configured limit',
      );
  }
  if (!records.length)
    throw new BadRequestException('CSV contains no QSO rows');
  return records;
}

function parseRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let closedQuote = false;
  const input = text.replace(/^\uFEFF/, '');

  for (let i = 0; i < input.length; i++) {
    const character = input[i];
    if (quoted) {
      if (character === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (character === '"') {
        quoted = false;
        closedQuote = true;
      } else field += character;
      continue;
    }
    if (
      closedQuote &&
      character !== ',' &&
      character !== '\r' &&
      character !== '\n'
    )
      throw new BadRequestException(
        'CSV has unexpected data after a quoted field',
      );
    if (character === '"') {
      if (field)
        throw new BadRequestException('CSV has an invalid quoted field');
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
      closedQuote = false;
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      closedQuote = false;
    } else {
      field += character;
    }
  }
  if (quoted)
    throw new BadRequestException('CSV has an unterminated quoted field');
  if (field || row.length || closedQuote) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
