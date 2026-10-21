import {
  adifAwardRecalculationKey,
  calculateAdifRejectedRecords,
  evaluateActivation,
  normalizeQso,
  normalizeTimestamp,
  parseTimestamp,
} from './activity-domain.js';

describe('calculateAdifRejectedRecords', () => {
  it('matches Python counting when a normalization error and duplicate occur', () => {
    expect(calculateAdifRejectedRecords(3, 1, 1)).toBe(3);
  });

  it('counts normalization errors again in addition to non-accepted records', () => {
    expect(calculateAdifRejectedRecords(1, 0, 1)).toBe(2);
  });
});

describe('adifAwardRecalculationKey', () => {
  it('uses the first normalized QSO key and activation ID as Python does', () => {
    expect(adifAwardRecalculationKey('activation-1', 'qso-key-1')).toBe(
      'batch:activation-1:qso-key-1',
    );
  });
});

describe('Python datetime.fromisoformat timestamp compatibility', () => {
  it('treats naive dates and date-times as UTC', () => {
    expect(normalizeTimestamp('2026-10-21')).toBe('2026-10-21T00:00:00Z');
    expect(normalizeTimestamp('2026-10-21 10:20:30')).toBe(
      '2026-10-21T10:20:30Z',
    );
  });

  it('normalizes ISO week dates and preserves sub-millisecond precision', () => {
    expect(normalizeTimestamp('2026-W43-3T10:20:30.123456+02:30')).toBe(
      '2026-10-21T07:50:30.123456Z',
    );
  });

  it('accepts compact date-times, comma fractions, and basic offsets', () => {
    expect(normalizeTimestamp('20261021T102030,123456+0230')).toBe(
      '2026-10-21T07:50:30.123456Z',
    );
  });

  it('normalizes timezone offsets with fractional seconds', () => {
    expect(normalizeTimestamp('2026-10-21T10:20:30.123456+00:00:30.5')).toBe(
      '2026-10-21T10:19:59.623456Z',
    );
  });

  it('rejects lowercase z like datetime.fromisoformat', () => {
    expect(() => parseTimestamp('2026-10-21T10:20:30z')).toThrow(
      'timestamp is invalid',
    );
  });
});

describe('QSO normalization compatibility', () => {
  it('matches the Python callsign, frequency, station, timestamp, and dedupe forms', () => {
    const qso = normalizeQso(
      {
        workedCallsign: ' f4xyz ',
        timestamp: '2026-W43-3T10:20:30.123456+02:30',
        band: '20 m',
        mode: 'ft-8',
        workedLocator: ' fn31pr ',
        hunterId: 'hunter-1',
        workedEntityId: 'entity-1',
      },
      'activation-1',
    );

    expect(qso).toMatchObject({
      workedCallsign: 'F4XYZ',
      timestamp: '2026-10-21T07:50:30.123456Z',
      band: '20M',
      mode: 'FT8',
      workedStationKey: 'F4XYZ|FN31PR',
      activationId: 'activation-1',
      source: 'manual',
      deduplicationKey:
        'ed0f7490bec700666ebff17a2ea103c1a91c70516e5736e9cd8936c0273eda2a',
    });
    expect(qso.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('rejects unsupported bands and modes', () => {
    expect(() =>
      normalizeQso(
        { workedCallsign: 'F4XYZ', timeOn: '2026-10-21', band: '5M' },
        'activation-1',
      ),
    ).toThrow('unsupported band: 5M');
    expect(() =>
      normalizeQso(
        { workedCallsign: 'F4XYZ', timeOn: '2026-10-21', mode: 'FT2' },
        'activation-1',
      ),
    ).toThrow('unsupported mode: FT2');
  });
});

describe('activation rule evaluation compatibility', () => {
  it('preserves the reference violation order and evaluation metadata', () => {
    const result = evaluateActivation(
      {
        startedAt: '2026-10-21T10:00:00Z',
        validityExpiresAt: '2026-10-21T12:00:00Z',
        programmeRules: {
          version: 'rules-v3',
          minimumQsos: 2,
          allowedBands: ['20M'],
          allowedModes: ['FT8'],
        },
      },
      [{ band: '40M', mode: 'SSB' }],
      '2026-10-21T13:00:00Z',
    );

    expect(result).toMatchObject({
      valid: false,
      violations: [
        'activation exceeded its validity window',
        'minimum QSO requirement was not met',
        'band 40M is not allowed',
        'mode SSB is not allowed',
      ],
      qsoCount: 1,
      ruleVersion: 'rules-v3',
    });
    expect(result.evaluatedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
    );
  });

  it('ignores a falsey endedAt value like the Python reference', () => {
    const result = evaluateActivation(
      { startedAt: '2026-10-21T10:00:00Z', programmeRules: {} },
      [],
      '',
    );

    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });
});
