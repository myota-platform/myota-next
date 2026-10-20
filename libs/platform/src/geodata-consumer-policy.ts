const decimalDigitZeroes = [
  0x0030, 0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66,
  0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0de6, 0x0e50, 0x0ed0, 0x0f20, 0x1040,
  0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0,
  0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0,
  0xff10, 0x104a0, 0x10d30, 0x11066, 0x110f0, 0x11136, 0x111d0, 0x112f0,
  0x11450, 0x114d0, 0x11650, 0x116c0, 0x11730, 0x118e0, 0x11950, 0x11c50,
  0x11d50, 0x11da0, 0x11f50, 0x16a60, 0x16ac0, 0x16b50, 0x1d7ce, 0x1d7d8,
  0x1d7e2, 0x1d7ec, 0x1d7f6, 0x1e140, 0x1e2f0, 0x1e4f0, 0x1e950, 0x1fbf0,
];

export type GeodataConsumerPolicy = {
  ackWaitSeconds: number;
  maxPending: number;
  maxDeliveries: number;
};

type RegisteredGeodataConsumerPolicy = GeodataConsumerPolicy & {
  maxPendingSetting: string;
  legacyMaxPendingSetting?: string;
};

const policies: Record<string, RegisteredGeodataConsumerPolicy> = {
  'geodata-preprocessing-v1': {
    ackWaitSeconds: 300,
    maxPending: 1,
    maxDeliveries: 100,
    maxPendingSetting: 'GEODATA_WORKER_PREPROCESSING_MAX_ACK_PENDING',
  },
  'geodata-import-promotion-v1': {
    ackWaitSeconds: 300,
    maxPending: 1,
    maxDeliveries: 100,
    maxPendingSetting: 'GEODATA_WORKER_PROMOTION_MAX_ACK_PENDING',
  },
  'geodata-entity-deletion-v1': {
    ackWaitSeconds: 120,
    maxPending: 1,
    maxDeliveries: 100,
    maxPendingSetting: 'GEODATA_WORKER_DELETION_MAX_ACK_PENDING',
    legacyMaxPendingSetting: 'MYOTA_DELETION_WORKERS',
  },
  'geodata-location-enrichment-v1': {
    ackWaitSeconds: 120,
    maxPending: 4,
    maxDeliveries: 8,
    maxPendingSetting: 'GEODATA_WORKER_ENRICHMENT_MAX_ACK_PENDING',
    legacyMaxPendingSetting: 'MYOTA_LOCATION_WORKERS',
  },
};

export function geodataConsumerPolicy(
  durable: string,
  environment: NodeJS.ProcessEnv = process.env,
): GeodataConsumerPolicy {
  const registered = policies[durable];
  if (!registered)
    throw new Error(`No Geodata policy registered for ${durable}`);
  return {
    ackWaitSeconds:
      optionalPositiveSetting('GEODATA_WORKER_ACK_WAIT_SECONDS', environment) ??
      registered.ackWaitSeconds,
    maxPending:
      optionalPositiveSetting(registered.maxPendingSetting, environment) ??
      optionalPositiveSetting('GEODATA_WORKER_MAX_ACK_PENDING', environment) ??
      optionalWorkerConcurrencySetting(
        registered.legacyMaxPendingSetting,
        environment,
      ) ??
      registered.maxPending,
    maxDeliveries:
      optionalPositiveSetting('GEODATA_WORKER_MAX_DELIVERIES', environment) ??
      registered.maxDeliveries,
  };
}

function optionalWorkerConcurrencySetting(
  name: string | undefined,
  environment: NodeJS.ProcessEnv,
): number | undefined {
  if (!name || environment[name] === undefined || environment[name] === '')
    return undefined;
  const normalized = normalizePythonIntegerText(environment[name]!);
  if (!/^[+-]?\d(?:_?\d)*$/.test(normalized))
    throw new Error(`${name} must be a base-10 integer`);
  const value = BigInt(normalized.replaceAll('_', ''));
  if (value <= 1n) return 1;
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(`${name} must be a positive safe integer`);
  return Number(value);
}

function optionalPositiveSetting(
  name: string,
  environment: NodeJS.ProcessEnv,
): number | undefined {
  const raw = environment[name];
  if (raw === undefined) return undefined;
  const normalized = normalizePythonIntegerText(raw);
  if (!/^[+-]?\d(?:_?\d)*$/.test(normalized))
    throw new Error(`${name} must be a base-10 integer`);
  const value = BigInt(normalized.replaceAll('_', ''));
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(`${name} must be a positive safe integer`);
  return Number(value);
}

function normalizePythonIntegerText(value: string): string {
  const trimmed = Array.from(value);
  let start = 0;
  let end = trimmed.length;
  while (start < end && isPythonNumericWhitespace(trimmed[start])) start += 1;
  while (end > start && isPythonNumericWhitespace(trimmed[end - 1])) end -= 1;
  return trimmed
    .slice(start, end)
    .map((character) => {
      const codePoint = character.codePointAt(0)!;
      let low = 0;
      let high = decimalDigitZeroes.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (decimalDigitZeroes[middle] <= codePoint) low = middle + 1;
        else high = middle;
      }
      const zero = decimalDigitZeroes[low - 1];
      return zero !== undefined && codePoint < zero + 10
        ? String(codePoint - zero)
        : character;
    })
    .join('');
}

function isPythonNumericWhitespace(value: string): boolean {
  const codePoint = value.codePointAt(0)!;
  return (
    (codePoint >= 0x09 && codePoint <= 0x0d) ||
    codePoint === 0x20 ||
    codePoint === 0x85 ||
    codePoint === 0xa0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000
  );
}
