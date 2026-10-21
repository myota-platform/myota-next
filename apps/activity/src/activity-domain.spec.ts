import {
  adifAwardRecalculationKey,
  calculateAdifRejectedRecords,
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
