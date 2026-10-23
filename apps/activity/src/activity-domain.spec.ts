import { NotFoundException } from '@nestjs/common';
import {
  adifAwardRecalculationKey,
  calculateAdifRejectedRecords,
  evaluateActivation,
  normalizeActivation,
  parseAdif,
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
  it('uses the activation value from the programme minimum QSO rule object', () => {
    const result = evaluateActivation(
      {
        startedAt: '2026-10-21T10:00:00Z',
        programmeRules: {
          minimumQsos: { activation: 2, hunter: 1 },
        },
      },
      [{ band: '20M', mode: 'SSB' }],
      '2026-10-21T11:00:00Z',
    );

    expect(result).toMatchObject({
      valid: false,
      violations: ['minimum QSO requirement was not met'],
      qsoCount: 1,
    });
  });

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

describe('activation validation compatibility', () => {
  it('preserves Python missing-startedAt lookup status after earlier checks', () => {
    expect(() => normalizeActivation({})).toThrow(NotFoundException);
    expect(() =>
      normalizeActivation({
        programmeRules: { requireLocation: true },
        location: {},
      }),
    ).toThrow('programme rules require an activation location');
  });

  it('normalizes the callsign, UTC start time, location, and rules alias', () => {
    const result = normalizeActivation({
      operatorCallsign: ' dl1abc ',
      callsignLifecycleStatus: 'UNVERIFIED',
      authorizedCallsigns: ['DL1ABC'],
      programmeRules: {},
      rules: {
        allowUnverifiedCallsign: true,
        requireLocation: true,
        entityBounds: {
          minLatitude: 45,
          maxLatitude: 48,
          minLongitude: 6,
          maxLongitude: 10,
        },
      },
      location: { latitude: '46.2', longitude: '7.3' },
      startedAt: '2026-10-21T10:20:30+02:00',
    });

    expect(result).toMatchObject({
      operatorCallsign: 'DL1ABC',
      programmeRules: {
        allowUnverifiedCallsign: true,
        requireLocation: true,
      },
      location: { latitude: '46.2', longitude: '7.3' },
      startedAt: '2026-10-21T08:20:30Z',
    });
  });

  it('converts pair iterables to dictionaries like the Python validator', () => {
    const result = normalizeActivation({
      programmeRules: [['requireLocation', true]],
      location: [
        ['latitude', '46.2'],
        ['longitude', '7.3'],
      ],
      startedAt: '2026-10-21T10:20:30Z',
    });

    expect(result.programmeRules).toEqual({ requireLocation: true });
    expect(result.location).toEqual({ latitude: '46.2', longitude: '7.3' });
    expect(
      normalizeActivation({
        programmeRules: ['xy'],
        startedAt: '2026-10-21T10:20:30Z',
      }).programmeRules,
    ).toEqual({ x: 'y' });
    expect(() =>
      normalizeActivation({
        programmeRules: 'x',
        startedAt: '2026-10-21T10:20:30Z',
      }),
    ).toThrow(
      'dictionary update sequence element #0 has length 1; 2 is required',
    );
  });

  it.each([
    [
      'requires coordinates when the programme rule says so',
      { programmeRules: { requireLocation: true }, location: {} },
      'programme rules require an activation location',
    ],
    [
      'rejects a location outside entity bounds',
      {
        rules: {
          entityBounds: {
            minLatitude: 45,
            maxLatitude: 48,
            minLongitude: 6,
            maxLongitude: 10,
          },
        },
        location: { latitude: 49, longitude: 7 },
      },
      'activation location is outside the entity bounds',
    ],
    [
      'rejects an unauthorized callsign',
      {
        operatorCallsign: 'F4XYZ',
        authorizedCallsigns: ['DL1ABC'],
      },
      'operator callsign is not authorized for this account',
    ],
    [
      'rejects retired callsigns',
      {
        operatorCallsign: 'DL1ABC',
        callsignLifecycleStatus: 'RETIRED',
      },
      'retired callsigns cannot start activations',
    ],
  ])('%s', (_label, additions, message) => {
    expect(() =>
      normalizeActivation({
        startedAt: '2026-10-21T10:00:00Z',
        ...(additions as Record<string, unknown>),
      }),
    ).toThrow(message as string);
  });
});

describe('ADIF parser compatibility', () => {
  it('maps, slices, and normalizes common fields across multiple records', () => {
    const records = parseAdif(
      '<ADIF_VER:5>3.1.4<EOH><CALL:7> f4xyz <QSO_DATE:8>20261021<TIME_ON:6>102030<BAND:3>20m<MODE:3>FT8<GRIDSQUARE:6>fn31pr<EOR><CALL:4>DL1A<QSO_DATE_TIME>2026-10-21T10:30:00Z<RST_SENT:3>599<RST_RCVD:3>579<EOR>',
    );

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      workedCallsign: 'F4XYZ',
      timestamp: '2026-10-21T10:20:30Z',
      band: '20M',
      mode: 'FT8',
      workedLocator: 'fn31pr',
      workedStationKey: 'F4XYZ|FN31PR',
    });
    expect(records[1]).toMatchObject({
      workedCallsign: 'DL1A',
      timestamp: '2026-10-21T10:30:00Z',
      rst: '599',
      rstReceived: '579',
    });
  });

  it('ignores incomplete records without both a callsign and timestamp', () => {
    expect(parseAdif('<CALL:5>F4XYZ<EOR><QSO_DATE:8>20261021<EOR>')).toEqual(
      [],
    );
  });
});
