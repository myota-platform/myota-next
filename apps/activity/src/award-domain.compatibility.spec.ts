import { evaluateAwardCondition } from './award-domain.js';

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
