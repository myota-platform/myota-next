/** Keep uncertain mutation keys available for same-tab retries and reloads. */
export function createPendingIdempotencyKeys(storageKey: string) {
  let storage: Storage | undefined;
  let values = new Map<string, string>();

  try {
    storage = window.sessionStorage;
    const saved: unknown = JSON.parse(storage.getItem(storageKey) || '[]');
    if (Array.isArray(saved)) {
      const entries = saved.filter(
        (entry): entry is [string, string] =>
          Array.isArray(entry) &&
          typeof entry[0] === 'string' &&
          typeof entry[1] === 'string',
      );
      values = new Map(entries);
    }
  } catch {
    storage = undefined;
  }

  function persist(): void {
    try {
      storage?.setItem(storageKey, JSON.stringify([...values.entries()]));
    } catch {
      // In-memory retry keys remain available when browser storage is unavailable.
    }
  }

  return {
    getOrCreate(fingerprint: string): string {
      let key = values.get(fingerprint);
      if (!key) {
        key = crypto.randomUUID();
        values.set(fingerprint, key);
        persist();
      }
      return key;
    },
    complete(fingerprint: string): void {
      if (values.delete(fingerprint)) persist();
    },
  };
}
