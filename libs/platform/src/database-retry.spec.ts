import { describe, expect, it } from 'vitest';
import {
  isTransientDatabaseError,
  retryTransientDatabaseOperation,
} from './database-retry.js';

describe('transient database retry', () => {
  it('recognizes PostgreSQL driver connection termination without a code', () => {
    expect(
      isTransientDatabaseError(new Error('Connection terminated unexpectedly')),
    ).toBe(true);
  });

  it('retries driver connection termination and returns the recovered result', async () => {
    let attempts = 0;
    const result = await retryTransientDatabaseOperation(
      async () => {
        attempts++;
        if (attempts === 1)
          throw new Error('Connection terminated unexpectedly');
        return 'ready';
      },
      {
        stopping: () => false,
        onRetry: () => undefined,
        wait: async () => undefined,
      },
    );

    expect(result).toBe('ready');
    expect(attempts).toBe(2);
  });
});
