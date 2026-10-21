export type TransientDatabaseRetryOptions = {
  stopping: () => boolean;
  onRetry: (error: unknown, attempt: number) => void;
  wait: (milliseconds: number) => Promise<void>;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

const transientCodes = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  '53300',
  '55P03',
  '57P01',
  '57P02',
  '57P03',
  '40001',
  '40P01',
]);

export async function retryTransientDatabaseOperation<T>(
  operation: () => Promise<T>,
  options: TransientDatabaseRetryOptions,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientDatabaseError(error) || options.stopping()) throw error;
      attempt += 1;
      options.onRetry(error, attempt);
      const exponentialDelay = Math.min(
        options.maxDelayMs ?? 30_000,
        (options.baseDelayMs ?? 1_000) * 2 ** Math.min(attempt - 1, 5),
      );
      const delay = Math.max(
        1,
        Math.floor(exponentialDelay * (0.5 + Math.random() * 0.5)),
      );
      await options.wait(delay);
      if (options.stopping()) throw error;
    }
  }
}

export function isTransientDatabaseError(error: unknown): boolean {
  const pending = [error];
  const visited = new Set<unknown>();
  while (pending.length > 0 && visited.size < 16) {
    const current = pending.pop();
    if (current === null || typeof current !== 'object' || visited.has(current))
      continue;
    visited.add(current);
    const record = current as Record<string, unknown>;
    const code = record.code;
    if (
      typeof code === 'string' &&
      (code.startsWith('08') || transientCodes.has(code))
    )
      return true;
    if (record.cause !== undefined) pending.push(record.cause);
    if (Array.isArray(record.errors)) pending.push(...record.errors);
  }
  return false;
}
