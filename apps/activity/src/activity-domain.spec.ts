import {
  adifAwardRecalculationKey,
  calculateAdifRejectedRecords,
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
