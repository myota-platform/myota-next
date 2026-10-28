/**
 * The shared, runtime-owned validation contract for award definitions.
 * Activity API and Admin import this module so they enforce the same rules.
 */

export interface AwardValidationIssue {
  path: string;
  message: string;
}

export interface AwardValidationOptions {
  /** Allows fields that are present on a stored definition but cannot be sent by clients. */
  allowStoredFields?: boolean;
  /** Validates an API PATCH fragment without requiring the whole definition. */
  partial?: boolean;
}

export const AWARD_DEFINITION_INPUT_FIELDS = [
  'awardId',
  'programmeSlug',
  'code',
  'name',
  'description',
  'awardText',
  'category',
  'achievementMetric',
  'condition',
  'levels',
  'backgroundAsset',
  'printSpec',
  'template',
  'signatureAssetId',
  'managerName',
  'effectiveFrom',
  'expectedVersion',
] as const;

const DEFINITION_FIELDS = new Set<string>(AWARD_DEFINITION_INPUT_FIELDS);

const STORED_FIELDS = new Set([
  'id',
  'version',
  'status',
  'createdAt',
  'updatedAt',
  'submittedAt',
  'reviewedAt',
  'publishedAt',
  'retiredAt',
  'revisionOf',
  'printReadiness',
]);

const REQUIRED_FIELDS = [
  'programmeSlug',
  'code',
  'name',
  'category',
  'condition',
  'levels',
  'backgroundAsset',
  'template',
];

const METRICS = new Set([
  'QSO_COUNT',
  'ACTIVATION_COUNT',
  'UNIQUE_CALLSIGNS',
  'UNIQUE_ENTITIES',
]);
const OPERATORS = new Set(['GTE', 'GT', 'EQ', 'LTE', 'LT']);
const CONDITION_KINDS = new Set([
  'AND',
  'ALL',
  'OR',
  'ANY',
  'NOT',
  'ENTITY_TYPE',
  'FIELD',
  ...METRICS,
]);
const REQUIRED_TEMPLATE_KINDS = [
  'AWARD_NAME',
  'CALLSIGN',
  'PERSON_NAME',
  'DATE_OBTAINED',
  'MANAGER_NAME',
  'MANAGER_SIGNATURE',
];
const OPTIONAL_TEMPLATE_KINDS = ['AWARD_TEXT', 'CUSTOM_TEXT'];
const MAX_VALIDATION_ISSUES = 50;

/** Return all structural and semantic violations in a submitted award definition. */
export function validateAwardConfiguration(
  value: unknown,
  options: AwardValidationOptions = {},
): AwardValidationIssue[] {
  const issues: AwardValidationIssue[] = [];
  const root = asRecord(value);
  if (!root) return [{ path: '$', message: 'must be an object' }];

  const allowed = options.allowStoredFields
    ? new Set([...DEFINITION_FIELDS, ...STORED_FIELDS])
    : DEFINITION_FIELDS;
  checkUnknownFields(root, allowed, '', issues);

  if (!options.partial) {
    for (const field of REQUIRED_FIELDS)
      if (!Object.hasOwn(root, field) || root[field] === null)
        add(issues, field, 'is required');
  }

  for (const field of ['programmeSlug', 'code', 'name'])
    if (Object.hasOwn(root, field))
      checkString(root[field], field, issues, { nonEmpty: true });
  for (const field of ['description', 'managerName'])
    if (Object.hasOwn(root, field)) checkString(root[field], field, issues);
  if (Object.hasOwn(root, 'awardText'))
    checkString(root.awardText, 'awardText', issues, { maxLength: 200 });

  if (Object.hasOwn(root, 'category')) {
    if (
      typeof root.category !== 'string' ||
      !['HUNTER', 'ACTIVATOR'].includes(root.category.toUpperCase())
    )
      add(issues, 'category', 'must be HUNTER or ACTIVATOR');
  }
  if (Object.hasOwn(root, 'achievementMetric'))
    checkEnum(
      root.achievementMetric,
      METRICS,
      'achievementMetric',
      issues,
      false,
    );
  if (Object.hasOwn(root, 'condition'))
    validateCondition(root.condition, 'condition', issues, 0);
  if (Object.hasOwn(root, 'levels')) validateLevels(root.levels, issues);
  if (Object.hasOwn(root, 'backgroundAsset'))
    validateBackground(root.backgroundAsset, issues, options.allowStoredFields);
  if (Object.hasOwn(root, 'printSpec'))
    validatePrintSpec(root.printSpec, issues);
  if (Object.hasOwn(root, 'template')) validateTemplate(root.template, issues);

  if (Object.hasOwn(root, 'signatureAssetId') && root.signatureAssetId !== null)
    checkString(root.signatureAssetId, 'signatureAssetId', issues, {
      nonEmpty: true,
    });
  if (
    Object.hasOwn(root, 'effectiveFrom') &&
    root.effectiveFrom !== null &&
    root.effectiveFrom !== undefined
  )
    checkString(root.effectiveFrom, 'effectiveFrom', issues, {
      nonEmpty: true,
    });
  if (Object.hasOwn(root, 'awardId') && root.awardId !== undefined)
    checkString(root.awardId, 'awardId', issues, { nonEmpty: true });
  if (Object.hasOwn(root, 'expectedVersion'))
    checkPositiveInteger(root.expectedVersion, 'expectedVersion', issues);

  if (options.allowStoredFields) {
    for (const field of [
      'id',
      'status',
      'createdAt',
      'updatedAt',
      'submittedAt',
      'reviewedAt',
      'publishedAt',
      'retiredAt',
      'revisionOf',
    ])
      if (Object.hasOwn(root, field) && root[field] !== null)
        checkString(root[field], field, issues, { nonEmpty: true });
    if (Object.hasOwn(root, 'version'))
      checkPositiveInteger(root.version, 'version', issues);
    if (Object.hasOwn(root, 'status'))
      checkEnum(
        root.status,
        new Set([
          'DRAFT',
          'UNDER_REVIEW',
          'APPROVED',
          'CHANGES_REQUESTED',
          'PUBLISHED',
          'RETIRED',
        ]),
        'status',
        issues,
        false,
      );
    if (Object.hasOwn(root, 'printReadiness') && !asRecord(root.printReadiness))
      add(issues, 'printReadiness', 'must be an object');
  }

  return issues;
}

export function formatAwardValidationIssues(
  issues: AwardValidationIssue[],
): string {
  return issues
    .map(({ path, message }) => `${path || '$'} ${message}`)
    .join('; ');
}

export function pickAwardDefinitionInput(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    AWARD_DEFINITION_INPUT_FIELDS.filter((field) =>
      Object.hasOwn(value, field),
    ).map((field) => [field, value[field]]),
  );
}

function validateCondition(
  value: unknown,
  path: string,
  issues: AwardValidationIssue[],
  depth: number,
): void {
  if (depth > 32) {
    add(issues, path, 'must not be nested more than 32 levels');
    return;
  }
  const condition = asRecord(value);
  if (!condition) {
    add(issues, path, 'must be an object');
    return;
  }
  const kind =
    typeof condition.kind === 'string' ? condition.kind.toUpperCase() : '';
  if (!CONDITION_KINDS.has(kind)) {
    add(issues, `${path}.kind`, 'has an unsupported condition kind');
    return;
  }

  const allowed =
    kind === 'AND' || kind === 'ALL' || kind === 'OR' || kind === 'ANY'
      ? new Set(['kind', 'conditions'])
      : kind === 'NOT'
        ? new Set(['kind', 'condition'])
        : kind === 'ENTITY_TYPE'
          ? new Set(['kind', 'values'])
          : kind === 'FIELD'
            ? new Set(['kind', 'field', 'operator', 'value'])
            : new Set(['kind', 'operator', 'value']);
  checkUnknownFields(condition, allowed, path, issues);

  if (kind === 'AND' || kind === 'ALL' || kind === 'OR' || kind === 'ANY') {
    if (
      !Array.isArray(condition.conditions) ||
      condition.conditions.length === 0
    ) {
      add(issues, `${path}.conditions`, 'must be a non-empty array');
      return;
    }
    condition.conditions.forEach((child: unknown, index: number) =>
      validateCondition(
        child,
        `${path}.conditions[${index}]`,
        issues,
        depth + 1,
      ),
    );
    return;
  }
  if (kind === 'NOT') {
    if (!Object.hasOwn(condition, 'condition'))
      add(issues, `${path}.condition`, 'is required');
    else
      validateCondition(
        condition.condition,
        `${path}.condition`,
        issues,
        depth + 1,
      );
    return;
  }
  if (kind === 'ENTITY_TYPE') {
    if (
      !Array.isArray(condition.values) ||
      condition.values.length === 0 ||
      condition.values.some(
        (item: unknown) => typeof item !== 'string' || !item.trim(),
      )
    )
      add(
        issues,
        `${path}.values`,
        'must be a non-empty array of non-empty strings',
      );
    return;
  }
  if (kind === 'FIELD')
    checkString(condition.field, `${path}.field`, issues, { nonEmpty: true });
  if (Object.hasOwn(condition, 'operator'))
    checkEnum(condition.operator, OPERATORS, `${path}.operator`, issues);
  if (!Object.hasOwn(condition, 'value'))
    add(issues, `${path}.value`, 'is required');
  else checkNumeric(condition.value, `${path}.value`, issues);
}

function validateLevels(value: unknown, issues: AwardValidationIssue[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    add(issues, 'levels', 'must be a non-empty array');
    return;
  }
  value.forEach((item: unknown, index: number) => {
    const path = `levels[${index}]`;
    const level = asRecord(item);
    if (!level) {
      add(issues, path, 'must be an object');
      return;
    }
    checkUnknownFields(
      level,
      new Set(['id', 'name', 'threshold']),
      path,
      issues,
    );
    checkString(level.id, `${path}.id`, issues, { nonEmpty: true });
    checkString(level.name, `${path}.name`, issues, { nonEmpty: true });
    if (!Object.hasOwn(level, 'threshold'))
      add(issues, `${path}.threshold`, 'is required');
    else {
      checkNumeric(level.threshold, `${path}.threshold`, issues);
      const threshold = numericValue(level.threshold);
      if (threshold !== null && threshold <= 0)
        add(issues, `${path}.threshold`, 'must be greater than zero');
    }
  });
}

function validateBackground(
  value: unknown,
  issues: AwardValidationIssue[],
  allowStoredFields = false,
): void {
  const background = asRecord(value);
  if (!background) {
    add(issues, 'backgroundAsset', 'must be an object');
    return;
  }
  const fields = new Set([
    'kind',
    'name',
    'objectKey',
    'mediaType',
    'widthPx',
    'heightPx',
    ...(allowStoredFields
      ? [
          'id',
          'sha256',
          'storage',
          'bucket',
          'objectStorageEndpoint',
          'contentStatus',
          'createdAt',
          'contentSha256',
          'contentSize',
          'storedAt',
        ]
      : []),
  ]);
  checkUnknownFields(background, fields, 'backgroundAsset', issues);
  if (Object.hasOwn(background, 'kind') && background.kind !== 'BACKGROUND')
    add(issues, 'backgroundAsset.kind', 'must be BACKGROUND');
  for (const field of [
    'id',
    'name',
    'objectKey',
    'mediaType',
    'sha256',
    'storage',
    'bucket',
    'objectStorageEndpoint',
    'contentStatus',
    'createdAt',
    'contentSha256',
    'storedAt',
  ])
    if (Object.hasOwn(background, field) && background[field] !== null)
      checkString(background[field], `backgroundAsset.${field}`, issues);
  if (
    Object.hasOwn(background, 'mediaType') &&
    !['image/png', 'image/jpeg'].includes(
      String(background.mediaType).toLowerCase(),
    )
  )
    add(issues, 'backgroundAsset.mediaType', 'must be image/png or image/jpeg');
  for (const field of ['widthPx', 'heightPx'])
    if (Object.hasOwn(background, field))
      checkPositiveInteger(
        background[field],
        `backgroundAsset.${field}`,
        issues,
      );
  if (Object.hasOwn(background, 'contentSize'))
    checkPositiveInteger(
      background.contentSize,
      'backgroundAsset.contentSize',
      issues,
    );
}

function validatePrintSpec(
  value: unknown,
  issues: AwardValidationIssue[],
): void {
  const spec = asRecord(value);
  if (!spec) {
    add(issues, 'printSpec', 'must be an object');
    return;
  }
  checkUnknownFields(
    spec,
    new Set(['page', 'orientation', 'dpi']),
    'printSpec',
    issues,
  );
  if (
    Object.hasOwn(spec, 'page') &&
    !['A4', 'LETTER'].includes(String(spec.page).toUpperCase())
  )
    add(issues, 'printSpec.page', 'must be A4 or LETTER');
  if (
    Object.hasOwn(spec, 'orientation') &&
    !['PORTRAIT', 'LANDSCAPE'].includes(String(spec.orientation).toUpperCase())
  )
    add(issues, 'printSpec.orientation', 'must be PORTRAIT or LANDSCAPE');
  if (Object.hasOwn(spec, 'dpi')) {
    checkNumeric(spec.dpi, 'printSpec.dpi', issues);
    const dpi = numericValue(spec.dpi);
    if (dpi !== null && (!Number.isInteger(dpi) || dpi < 150 || dpi > 300))
      add(issues, 'printSpec.dpi', 'must be an integer between 150 and 300');
  }
}

function validateTemplate(
  value: unknown,
  issues: AwardValidationIssue[],
): void {
  const template = asRecord(value);
  if (!template) {
    add(issues, 'template', 'must be an object');
    return;
  }
  checkUnknownFields(template, new Set(['elements']), 'template', issues);
  if (!Array.isArray(template.elements)) {
    add(issues, 'template.elements', 'must be an array');
    return;
  }
  const allowedKinds = new Set([
    ...REQUIRED_TEMPLATE_KINDS,
    ...OPTIONAL_TEMPLATE_KINDS,
  ]);
  const seen = new Set<string>();
  template.elements.forEach((item: unknown, index: number) => {
    const path = `template.elements[${index}]`;
    const element = asRecord(item);
    if (!element) {
      add(issues, path, 'must be an object');
      return;
    }
    checkUnknownFields(
      element,
      new Set(['kind', 'label', 'x', 'y', 'width', 'height']),
      path,
      issues,
    );
    if (typeof element.kind !== 'string' || !allowedKinds.has(element.kind)) {
      add(issues, `${path}.kind`, 'has an unsupported certificate element');
      return;
    }
    seen.add(element.kind);
    if (Object.hasOwn(element, 'label'))
      checkString(element.label, `${path}.label`, issues, {
        nonEmpty: element.kind === 'CUSTOM_TEXT',
      });
    const coords: Record<string, number | null> = {};
    for (const field of ['x', 'y', 'width', 'height']) {
      if (!Object.hasOwn(element, field)) {
        add(issues, `${path}.${field}`, 'is required');
        coords[field] = null;
        continue;
      }
      checkNumeric(element[field], `${path}.${field}`, issues);
      const number = numericValue(element[field]);
      coords[field] = number;
      if (number !== null && (number < 0 || number > 1))
        add(issues, `${path}.${field}`, 'must be between zero and one');
    }
    if (coords.width !== null && coords.width <= 0)
      add(issues, `${path}.width`, 'must be greater than zero');
    if (coords.height !== null && coords.height <= 0)
      add(issues, `${path}.height`, 'must be greater than zero');
    if (
      coords.x !== null &&
      coords.width !== null &&
      coords.x + coords.width > 1.000001
    )
      add(issues, path, 'must fit inside the page horizontally');
    if (
      coords.y !== null &&
      coords.height !== null &&
      coords.y + coords.height > 1.000001
    )
      add(issues, path, 'must fit inside the page vertically');
  });
  for (const kind of REQUIRED_TEMPLATE_KINDS)
    if (!seen.has(kind))
      add(issues, 'template.elements', `is missing required element ${kind}`);
}

function checkUnknownFields(
  value: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
  issues: AwardValidationIssue[],
): void {
  for (const field of Object.keys(value))
    if (!allowed.has(field))
      add(
        issues,
        path ? `${path}.${field}` : field,
        'is not a supported field',
      );
}

function checkString(
  value: unknown,
  path: string,
  issues: AwardValidationIssue[],
  options: { nonEmpty?: boolean; maxLength?: number } = {},
): void {
  if (typeof value !== 'string') {
    add(issues, path, 'must be a string');
    return;
  }
  if (options.nonEmpty && !value.trim()) add(issues, path, 'must not be empty');
  if (
    options.maxLength !== undefined &&
    Array.from(value).length > options.maxLength
  )
    add(issues, path, `must be at most ${options.maxLength} characters`);
}

function checkEnum(
  value: unknown,
  allowed: Set<string>,
  path: string,
  issues: AwardValidationIssue[],
  caseInsensitive = true,
): void {
  if (
    typeof value !== 'string' ||
    !allowed.has(caseInsensitive ? value.toUpperCase() : value)
  )
    add(issues, path, `must be one of ${[...allowed].join(', ')}`);
}

function checkNumeric(
  value: unknown,
  path: string,
  issues: AwardValidationIssue[],
): void {
  if (numericValue(value) === null)
    add(issues, path, 'must be a finite number');
}

function checkPositiveInteger(
  value: unknown,
  path: string,
  issues: AwardValidationIssue[],
): void {
  const number = numericValue(value);
  if (number === null || !Number.isInteger(number) || number <= 0)
    add(issues, path, 'must be a positive integer');
}

function numericValue(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function add(
  issues: AwardValidationIssue[],
  path: string,
  message: string,
): void {
  if (issues.length >= MAX_VALIDATION_ISSUES) {
    if (issues.length === MAX_VALIDATION_ISSUES)
      issues.push({
        path: '$',
        message: 'additional validation issues omitted',
      });
    return;
  }
  issues.push({ path, message });
}
