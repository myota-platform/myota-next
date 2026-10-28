import {
  ProgrammeEntityIdentifierError,
  suggestProgrammeEntityIdentifier,
  type ProgrammeEntityNumberingPolicy,
} from './programme-entity-identifier.js';

describe('suggestProgrammeEntityIdentifier', () => {
  const policy: ProgrammeEntityNumberingPolicy = {
    identifier: 'PJE',
    qualifierMode: 'MANUAL',
    serialWidth: 4,
    assignmentMode: 'MANUAL',
  };

  it('returns the next scoped serial without reserving it', () => {
    expect(
      suggestProgrammeEntityIdentifier(
        policy,
        {},
        { qualifier: 'A Coruña' },
        23,
      ),
    ).toEqual({
      entityIdentifier: 'PJE-ACORUNA-0023',
      serial: 23,
      paddedSerial: '0023',
      qualifier: 'ACORUNA',
    });
  });

  it('derives a normalized qualifier from the configured location field', () => {
    expect(
      suggestProgrammeEntityIdentifier(
        {
          ...policy,
          qualifierMode: 'LOCATION',
          qualifierField: 'provinceCode',
        },
        { location: { provinceCode: 'a-coruna' } },
        undefined,
        1,
      ).entityIdentifier,
    ).toBe('PJE-ACORUNA-0001');
  });

  it('returns an explicit error at serial exhaustion', () => {
    expect(() =>
      suggestProgrammeEntityIdentifier(policy, {}, { qualifier: 'X' }, 10_000),
    ).toThrow(ProgrammeEntityIdentifierError);
  });
});
