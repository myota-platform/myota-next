import { readFileSync } from 'node:fs';
import {
  formatAwardValidationIssues,
  validateAwardConfiguration,
} from '../../../contracts/award-definition.js';

function readFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../../../contracts/fixtures/${name}`, import.meta.url),
      'utf8',
    ),
  );
}

describe('shared award definition validation', () => {
  it('accepts the canonical nested configuration fixture', () => {
    expect(
      validateAwardConfiguration(readFixture('award-definition-valid.json')),
    ).toEqual([]);
  });

  it('reports nested, unknown, and boundary errors with stable field paths', () => {
    const issues = validateAwardConfiguration(
      readFixture('award-definition-invalid.json'),
    );
    const formatted = formatAwardValidationIssues(issues);

    expect(formatted).toContain('notAField is not a supported field');
    expect(formatted).toContain(
      'condition.conditions[0].value must be a finite number',
    );
    expect(formatted).toContain('condition.conditions[0].unexpected');
    expect(formatted).toContain(
      'levels[0].threshold must be greater than zero',
    );
    expect(formatted).toContain(
      'backgroundAsset.extra is not a supported field',
    );
    expect(formatted).toContain('printSpec.page must be A4 or LETTER');
    expect(formatted).toContain(
      'printSpec.dpi must be an integer between 150 and 300',
    );
    expect(formatted).toContain(
      'template.elements[0] must fit inside the page horizontally',
    );
    expect(formatted).toContain('template.elements[1].label must not be empty');
    expect(formatted).toContain(
      'template.elements is missing required element CALLSIGN',
    );
  });

  it('allows stored metadata only when validating a merged definition', () => {
    const definition = readFixture('award-definition-valid.json') as Record<
      string,
      unknown
    >;
    definition.id = 'award-1';
    definition.version = 1;
    definition.status = 'DRAFT';
    definition.createdAt = '2026-10-28T00:00:00.000Z';
    const backgroundAsset = definition.backgroundAsset as Record<
      string,
      unknown
    >;
    backgroundAsset.id = 'stored-background-1';
    backgroundAsset.bucket = 'award-assets';
    backgroundAsset.contentStatus = 'STORED';

    expect(validateAwardConfiguration(definition)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'id',
          message: 'is not a supported field',
        }),
        expect.objectContaining({
          path: 'backgroundAsset.id',
          message: 'is not a supported field',
        }),
      ]),
    );
    expect(
      validateAwardConfiguration(definition, { allowStoredFields: true }),
    ).toEqual([]);
  });

  it('supports partial patches without weakening validation for supplied values', () => {
    expect(
      validateAwardConfiguration(
        { printSpec: { dpi: 301 } },
        { partial: true },
      ),
    ).toEqual([
      {
        path: 'printSpec.dpi',
        message: 'must be an integer between 150 and 300',
      },
    ]);
  });

  it('validates the optimistic version token used to create a published revision', () => {
    const input = readFixture('award-definition-valid.json') as Record<
      string,
      unknown
    >;
    input.awardId = 'published-award-2';
    input.expectedVersion = 4;
    expect(validateAwardConfiguration(input)).toEqual([]);
    expect(
      validateAwardConfiguration(
        { awardId: 'published-award-2', expectedVersion: 1.5 },
        { partial: true },
      ),
    ).toEqual([
      {
        path: 'expectedVersion',
        message: 'must be a positive integer',
      },
    ]);
  });
});
