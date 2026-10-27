import { evaluateAwardCondition, validateAwardDraft } from './award-domain.js';

describe('award condition compatibility', () => {
  it('evaluates nested AND and OR conditions like the Python reference', () => {
    const condition = {
      kind: 'AND',
      conditions: [
        {
          kind: 'OR',
          conditions: [
            { kind: 'QSO_COUNT', operator: 'GTE', value: 10 },
            { kind: 'UNIQUE_ENTITIES', operator: 'GTE', value: 3 },
          ],
        },
        { kind: 'ENTITY_TYPE', values: ['MUNICIPAL_PARK'] },
      ],
    };

    expect(
      evaluateAwardCondition(condition, {
        qsoCount: 12,
        uniqueEntityCount: 1,
        entityType: 'MUNICIPAL_PARK',
      }),
    ).toBe(true);
    expect(
      evaluateAwardCondition(condition, {
        qsoCount: 2,
        uniqueEntityCount: 1,
        entityType: 'MUNICIPAL_PARK',
      }),
    ).toBe(false);
  });
});

describe('award print profile and Award Text compatibility', () => {
  it('stores exact landscape output dimensions and accepts a sufficiently detailed source background', () => {
    const award = validateAwardDraft({
      programmeSlug: 'field-day',
      code: 'FIELD-DAY-1',
      name: 'Field Day One',
      awardText: 'For excellent operating',
      category: 'HUNTER',
      condition: { kind: 'QSO_COUNT', operator: 'GTE', value: 1 },
      levels: [{ id: 'one', name: 'One', threshold: 1 }],
      backgroundAsset: {
        id: 'asset-1',
        objectKey: 'small-source.png',
        mediaType: 'image/png',
        widthPx: 1920,
        heightPx: 1400,
      },
      printSpec: { page: 'A4', orientation: 'LANDSCAPE', dpi: 300 },
      template: {
        elements: [
          { kind: 'AWARD_NAME', x: 0.1, y: 0.1, width: 0.8, height: 0.1 },
          { kind: 'AWARD_TEXT', x: 0.1, y: 0.2, width: 0.8, height: 0.1 },
          { kind: 'CALLSIGN', x: 0.1, y: 0.3, width: 0.8, height: 0.1 },
          { kind: 'PERSON_NAME', x: 0.1, y: 0.4, width: 0.8, height: 0.1 },
          { kind: 'DATE_OBTAINED', x: 0.1, y: 0.5, width: 0.8, height: 0.1 },
          { kind: 'MANAGER_NAME', x: 0.1, y: 0.6, width: 0.8, height: 0.1 },
          {
            kind: 'MANAGER_SIGNATURE',
            x: 0.1,
            y: 0.7,
            width: 0.8,
            height: 0.1,
          },
        ],
      },
    });

    expect(award.awardText).toBe('For excellent operating');
    expect(award.backgroundAsset).toMatchObject({
      widthPx: 3508,
      heightPx: 2481,
    });
    expect(award.printReadiness).toMatchObject({
      printReady: true,
      recommended: { widthPx: 3508, heightPx: 2481 },
      source: { widthPx: 1920, heightPx: 1400 },
      resize: { fit: 'COVER', position: 'CENTER', applied: true },
    });
  });

  it('keeps Award Text optional for existing award definitions', () => {
    const award = validateAwardDraft({
      programmeSlug: 'field-day',
      code: 'FIELD-DAY-2',
      name: 'Field Day Two',
      category: 'HUNTER',
      condition: { kind: 'QSO_COUNT', operator: 'GTE', value: 1 },
      levels: [{ id: 'one', name: 'One', threshold: 1 }],
      backgroundAsset: {
        objectKey: 'background.png',
        mediaType: 'image/png',
        widthPx: 2481,
        heightPx: 3508,
      },
      printSpec: { page: 'A4', orientation: 'PORTRAIT', dpi: 300 },
      template: {
        elements: [
          { kind: 'AWARD_NAME', x: 0.1, y: 0.1, width: 0.8, height: 0.1 },
          { kind: 'CALLSIGN', x: 0.1, y: 0.2, width: 0.8, height: 0.1 },
          { kind: 'PERSON_NAME', x: 0.1, y: 0.3, width: 0.8, height: 0.1 },
          { kind: 'DATE_OBTAINED', x: 0.1, y: 0.4, width: 0.8, height: 0.1 },
          { kind: 'MANAGER_NAME', x: 0.1, y: 0.5, width: 0.8, height: 0.1 },
          {
            kind: 'MANAGER_SIGNATURE',
            x: 0.1,
            y: 0.6,
            width: 0.8,
            height: 0.1,
          },
        ],
      },
    });

    expect(award.awardText).toBe('');
  });
});
