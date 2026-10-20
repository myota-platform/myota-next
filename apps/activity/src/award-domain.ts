import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { normalizePythonNumericText } from '@app/platform/python-numeric.js';
import { trimPythonWhitespace } from '@app/platform/python-strings.js';
import {
  parseTimestamp,
  pythonFloat,
  type JsonRecord,
} from './activity-domain.js';

const REQUIRED_ELEMENTS = [
  'AWARD_NAME',
  'CALLSIGN',
  'PERSON_NAME',
  'DATE_OBTAINED',
  'MANAGER_NAME',
  'MANAGER_SIGNATURE',
];

export function validateAwardDraft(body: JsonRecord, existing?: JsonRecord) {
  for (const field of [
    'programmeSlug',
    'code',
    'name',
    'category',
    'condition',
    'levels',
    'backgroundAsset',
    'template',
  ]) {
    if (body[field] === undefined || body[field] === null)
      throw new BadRequestException(`${field} is required`);
  }
  const category = String(body.category).toUpperCase();
  if (!['HUNTER', 'ACTIVATOR'].includes(category))
    throw new BadRequestException('category must be HUNTER or ACTIVATOR');
  if (!Array.isArray(body.levels) || body.levels.length === 0)
    throw new BadRequestException('levels must contain positive thresholds');
  for (const level of body.levels) {
    if (numericValue(level?.threshold, 'level.threshold') <= 0)
      throw new BadRequestException('levels must contain positive thresholds');
  }
  const backgroundAsset = body.backgroundAsset as JsonRecord;
  if (
    !backgroundAsset ||
    typeof backgroundAsset !== 'object' ||
    Array.isArray(backgroundAsset)
  )
    throw new BadRequestException('backgroundAsset must be an object');
  if ((backgroundAsset.kind ?? 'BACKGROUND') !== 'BACKGROUND')
    throw new BadRequestException('backgroundAsset.kind must be BACKGROUND');
  const template = body.template as JsonRecord;
  validateTemplate(template?.elements);
  const printSpec = body.printSpec ?? {
    page: 'A4',
    orientation: 'PORTRAIT',
    dpi: 300,
  };
  const printReadiness = calculatePrintReadiness(backgroundAsset, printSpec);
  const now = new Date().toISOString();
  const versionValue = Object.hasOwn(body, 'version')
    ? body.version
    : (existing?.version ?? 1);
  const record: JsonRecord = {
    ...existing,
    id: body.awardId ?? existing?.id ?? randomUUID(),
    programmeSlug: body.programmeSlug,
    code: body.code,
    name: body.name,
    description: body.description ?? '',
    category,
    version: integerValue(versionValue, 'version'),
    achievementMetric: body.achievementMetric ?? 'QSO_COUNT',
    condition: body.condition,
    levels: body.levels,
    backgroundAsset,
    printSpec,
    template,
    status: existing?.status ?? 'DRAFT',
    updatedAt: now,
    createdAt: existing?.createdAt ?? now,
    printReadiness,
  };
  for (const field of ['signatureAssetId', 'managerName', 'effectiveFrom']) {
    if (body[field] !== undefined) {
      record[field] =
        field === 'effectiveFrom' && body[field]
          ? parseTimestamp(body[field]).toISOString()
          : body[field];
    }
  }
  return record;
}

export function validateTemplate(elements: unknown) {
  if (!Array.isArray(elements))
    throw new BadRequestException('template elements must be an array');
  const allowed = new Set([...REQUIRED_ELEMENTS, 'CUSTOM_TEXT']);
  const seen = new Set<string>();
  for (const item of elements) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new BadRequestException('template elements must be objects');
    const element = item as JsonRecord;
    const kind = String(element.kind ?? '');
    if (!allowed.has(kind))
      throw new BadRequestException(
        `unsupported certificate element: ${kind || 'missing'}`,
      );
    seen.add(kind);
    const label =
      element.label === undefined
        ? ''
        : element.label === null
          ? 'None'
          : String(element.label);
    if (kind === 'CUSTOM_TEXT' && !trimPythonWhitespace(label))
      throw new BadRequestException('custom text requires a label');
    for (const field of ['x', 'y', 'width', 'height']) {
      const value = Number(element[field]);
      if (!Number.isFinite(value) || value < 0 || value > 1)
        throw new BadRequestException(
          `template.${kind}.${field} must be between 0 and 1`,
        );
    }
    if (Number(element.width) <= 0 || Number(element.height) <= 0)
      throw new BadRequestException(
        `template.${kind} must have positive dimensions`,
      );
    if (
      Number(element.x) + Number(element.width) > 1.000001 ||
      Number(element.y) + Number(element.height) > 1.000001
    )
      throw new BadRequestException(
        `template.${kind} must fit inside the page`,
      );
  }
  const missing = REQUIRED_ELEMENTS.filter((kind) => !seen.has(kind));
  if (missing.length)
    throw new BadRequestException(
      `certificate template is missing: ${missing.join(', ')}`,
    );
}

export function evaluateAwardCondition(
  condition: JsonRecord,
  facts: JsonRecord,
): boolean {
  const kind = pythonConditionString(
    Object.hasOwn(condition, 'kind') ? condition.kind : '',
  ).toUpperCase();
  if (kind === 'AND' || kind === 'ALL') {
    const children = condition.conditions;
    return (
      Array.isArray(children) &&
      children.length > 0 &&
      children.every((child) => evaluateAwardCondition(child, facts))
    );
  }
  if (kind === 'OR' || kind === 'ANY') {
    const children = condition.conditions;
    return (
      Array.isArray(children) &&
      children.some((child) => evaluateAwardCondition(child, facts))
    );
  }
  if (kind === 'NOT')
    return !evaluateAwardCondition(condition.condition ?? {}, facts);
  if (kind === 'ENTITY_TYPE')
    return (condition.values ?? [])
      .map(String)
      .includes(String(facts.entityType ?? ''));
  const field =
    kind === 'FIELD'
      ? pythonConditionString(
          Object.hasOwn(condition, 'field') ? condition.field : '',
        )
      : {
          QSO_COUNT: 'qsoCount',
          ACTIVATION_COUNT: 'activationCount',
          UNIQUE_CALLSIGNS: 'uniqueCallsignCount',
          UNIQUE_ENTITIES: 'uniqueEntityCount',
        }[kind];
  if (!field)
    throw new BadRequestException(
      `unsupported award condition kind: ${kind || 'missing'}`,
    );
  const actual = numericValue(
    Object.hasOwn(facts, field) ? facts[field] : 0,
    field,
  );
  const expected = numericValue(
    Object.hasOwn(condition, 'value') ? condition.value : 0,
    'condition.value',
  );
  const operator = Object.hasOwn(condition, 'operator')
    ? condition.operator
    : 'GTE';
  switch (pythonConditionString(operator).toUpperCase()) {
    case 'GTE':
      return actual >= expected;
    case 'GT':
      return actual > expected;
    case 'EQ':
      return actual === expected;
    case 'LTE':
      return actual <= expected;
    case 'LT':
      return actual < expected;
    default:
      return false;
  }
}

function pythonConditionString(value: unknown): string {
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value.toString();
  if (typeof value === 'bigint' || typeof value === 'symbol')
    return value.toString();
  if (typeof value === 'undefined') return 'undefined';
  if (typeof value === 'object') return JSON.stringify(value) ?? 'None';
  return '[function]';
}

export function evaluateAward(
  award: JsonRecord,
  subjectId: string,
  facts: JsonRecord,
) {
  const conditionMet = evaluateAwardCondition(award.condition, facts);
  const metric = String(award.achievementMetric ?? 'QSO_COUNT');
  const metricField: Record<string, string> = {
    QSO_COUNT: 'qsoCount',
    ACTIVATION_COUNT: 'activationCount',
    UNIQUE_CALLSIGNS: 'uniqueCallsignCount',
    UNIQUE_ENTITIES: 'uniqueEntityCount',
  };
  const field = metricField[metric] ?? metric;
  const progress = numericValue(
    Object.hasOwn(facts, field) ? facts[field] : 0,
    field,
  );
  const levels = (award.levels ?? []).map((level: JsonRecord) => ({
    ...level,
    eligible:
      conditionMet &&
      progress >= numericValue(level.threshold, 'level.threshold'),
  }));
  return {
    awardId: award.id,
    subjectId,
    category: award.category,
    conditionMet,
    metric,
    progress,
    levels,
  };
}

function numericValue(value: unknown, field: string) {
  return pythonFloat(value, field);
}

function integerValue(value: unknown, field: string) {
  if (typeof value === 'number' && Number.isFinite(value))
    return Math.trunc(value);
  if (typeof value === 'boolean') return Number(value);
  if (typeof value === 'string') {
    const normalized = normalizePythonNumericText(value);
    if (/^[+-]?\d(?:_?\d)*$/.test(normalized))
      return Number(normalized.replaceAll('_', ''));
  }
  throw new BadRequestException(`${field} must be an integer`);
}

function calculatePrintReadiness(
  background: JsonRecord,
  spec: JsonRecord,
): JsonRecord {
  const page = String(spec.page ?? 'A4').toUpperCase();
  const orientation = String(spec.orientation ?? 'PORTRAIT').toUpperCase();
  if (
    !['A4', 'LETTER'].includes(page) ||
    !['PORTRAIT', 'LANDSCAPE'].includes(orientation)
  )
    throw new BadRequestException(
      'print page must be A4 or LETTER and orientation must be PORTRAIT or LANDSCAPE',
    );
  let [widthMm, heightMm] = page === 'A4' ? [210, 297] : [215.9, 279.4];
  if (orientation === 'LANDSCAPE') [widthMm, heightMm] = [heightMm, widthMm];
  const dpi = Number(spec.dpi ?? 300);
  if (!Number.isFinite(dpi) || dpi < 150)
    throw new BadRequestException(
      'print.dpi must be at least 150 for a printable certificate',
    );
  const recommended = {
    widthPx: Math.ceil((widthMm / 25.4) * dpi),
    heightPx: Math.ceil((heightMm / 25.4) * dpi),
  };
  const widthPx = Number(background.widthPx ?? 0);
  const heightPx = Number(background.heightPx ?? 0);
  if (widthPx <= 0 || heightPx <= 0)
    throw new BadRequestException(
      'background image dimensions are required for print readiness',
    );
  const expectedRatio = recommended.widthPx / recommended.heightPx;
  const actualRatio = widthPx / heightPx;
  const ratioDelta = Math.abs(actualRatio - expectedRatio) / expectedRatio;
  return {
    page,
    orientation,
    dpi,
    pageWidthMm: widthMm,
    pageHeightMm: heightMm,
    recommended,
    actual: { widthPx, heightPx },
    aspectRatioDelta: Number(ratioDelta.toFixed(5)),
    printReady: ratioDelta <= 0.03 && widthPx >= recommended.widthPx * 0.9,
  };
}
