import { describe, expect, it } from 'vitest';
import { isLoadTestCleanupEnabled } from './geodata-load-test-cleanup.service.js';

describe('load-test cleanup environment gate', () => {
  it.each(['development', 'test', 'testing', 'staging', 'production'])(
    'allows the explicitly enabled %s environment',
    (environment) => {
      expect(isLoadTestCleanupEnabled(environment, '1')).toBe(true);
    },
  );

  it('requires the explicit enable flag', () => {
    expect(isLoadTestCleanupEnabled('testing', undefined)).toBe(false);
    expect(isLoadTestCleanupEnabled('testing', '0')).toBe(false);
  });

  it('rejects undeclared environments', () => {
    expect(isLoadTestCleanupEnabled('preview', '1')).toBe(false);
  });
});
