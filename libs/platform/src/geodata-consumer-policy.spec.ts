import { describe, expect, it } from 'vitest';
import {
  geodataConsumerPolicy,
  geodataImportMaxAttempts,
} from './geodata-consumer-policy.js';

describe('Geodata consumer policy', () => {
  it('defaults import processing to a finite retry budget that outlasts short storage restarts', () => {
    expect(geodataImportMaxAttempts({})).toBe(10);
  });

  it('allows an explicit positive import retry budget', () => {
    expect(
      geodataImportMaxAttempts({ GEODATA_IMPORT_MAX_ATTEMPTS: '12' }),
    ).toBe(12);
  });

  it('rejects invalid import retry budgets', () => {
    expect(() =>
      geodataImportMaxAttempts({ GEODATA_IMPORT_MAX_ATTEMPTS: '0' }),
    ).toThrow('GEODATA_IMPORT_MAX_ATTEMPTS must be a positive safe integer');
    expect(() =>
      geodataImportMaxAttempts({ GEODATA_IMPORT_MAX_ATTEMPTS: 'many' }),
    ).toThrow('GEODATA_IMPORT_MAX_ATTEMPTS must be a base-10 integer');
  });

  it('keeps broker delivery policy independent from import-run attempts', () => {
    expect(geodataConsumerPolicy('geodata-preprocessing-v1', {})).toMatchObject(
      {
        maxDeliveries: 100,
      },
    );
  });
});
