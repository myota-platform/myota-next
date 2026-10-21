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

  async function storageFingerprint(fingerprint: string): Promise<string> {
    try {
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(fingerprint),
      );
      return Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
    } catch {
      return fingerprint;
    }
  }

  function persist(): void {
    try {
      storage?.setItem(storageKey, JSON.stringify([...values.entries()]));
    } catch {
      // In-memory retry keys remain available when browser storage is unavailable.
    }
  }

  return {
    async getOrCreate(fingerprint: string): Promise<string> {
      const storedFingerprint = await storageFingerprint(fingerprint);
      let key = values.get(storedFingerprint);
      if (!key) {
        key = crypto.randomUUID();
        values.set(storedFingerprint, key);
        persist();
      }
      return key;
    },
    async complete(fingerprint: string): Promise<void> {
      const storedFingerprint = await storageFingerprint(fingerprint);
      if (values.delete(storedFingerprint)) persist();
    },
  };
}
