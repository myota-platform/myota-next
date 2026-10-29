export type UploadStage = 'PREPARING' | 'UPLOADING' | 'VERIFYING' | 'COMPLETE';

export interface UploadProgress {
  stage: UploadStage;
  uploadedBytes: number;
  totalBytes: number;
  resumed: boolean;
}

export interface UploadMetadata {
  adapter: string;
  format: string;
  entityTypes: string[];
  programmeSlug?: string | null;
  source: Record<string, unknown>;
}

export type UploadRequest = <T>(
  path: string,
  options?: RequestInit,
) => Promise<T>;
export interface UploadStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface SavedUpload {
  idempotencyKey: string;
  uploadId?: string;
  partSizeBytes?: number;
}

interface UploadSession {
  uploadId: string;
  status: string;
  filename?: string;
  expectedSize?: number;
  partSizeBytes?: number;
  importRunId?: string;
  parts?: Array<{ partNumber: number; sizeBytes: number; sha256: string }>;
}

interface UploadOptions {
  ownerId: string;
  request: UploadRequest;
  storage: UploadStorage;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
}

const DEFAULT_PART_SIZE = 16 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 1024 ** 3;

function httpStatus(error: unknown): number | undefined {
  return error instanceof Error && 'status' in error
    ? Number(error.status)
    : undefined;
}

function sessionUnavailable(error: unknown): boolean {
  return (
    httpStatus(error) === 404 ||
    (httpStatus(error) === 400 &&
      error instanceof Error &&
      /upload session (?:has expired|is (?:expired|aborted|failed))/i.test(
        error.message,
      ))
  );
}

async function sha256(value: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', value);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

async function storageKeys(
  file: File,
  metadata: UploadMetadata,
  ownerId: string,
): Promise<{ key: string; legacyKey: string }> {
  if (!ownerId) throw new Error('Sign in again before uploading a dataset.');
  const { retrievedAt: _retrievedAt, ...source } = metadata.source;
  const identity = JSON.stringify([
    ownerId,
    file.name,
    file.size,
    file.lastModified,
    metadata.adapter,
    metadata.format,
    metadata.entityTypes,
    metadata.programmeSlug || '',
    source,
  ]);
  const legacyIdentity = `${file.name}:${file.size}:${file.lastModified}:${metadata.adapter}:${metadata.format}:${metadata.entityTypes[0]}${metadata.programmeSlug ? `:${metadata.programmeSlug}` : ''}`;
  return {
    key: `myota-geodata-upload:v2:${await sha256(new TextEncoder().encode(identity))}`,
    legacyKey: `myota-geodata-upload:${await sha256(new TextEncoder().encode(legacyIdentity))}`,
  };
}

function readSaved(storage: UploadStorage, key: string): SavedUpload | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as SavedUpload;
    return typeof record.idempotencyKey === 'string' ? record : null;
  } catch {
    return null;
  }
}

function ensureActive(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

async function retryPart(
  operation: () => Promise<unknown>,
  signal?: AbortSignal,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    ensureActive(signal);
    try {
      await operation();
      return;
    } catch (error) {
      ensureActive(signal);
      const status = httpStatus(error);
      if (
        attempt >= 2 ||
        (status !== undefined &&
          ![408, 429, 500, 502, 503, 504].includes(status))
      )
        throw error;
      await new Promise<void>((resolve, reject) => {
        const cancel = () => {
          clearTimeout(timer);
          reject(
            signal?.reason || new DOMException('Upload paused', 'AbortError'),
          );
        };
        const timer = setTimeout(
          () => {
            signal?.removeEventListener('abort', cancel);
            resolve();
          },
          500 * 2 ** attempt,
        );
        signal?.addEventListener('abort', cancel, { once: true });
      });
    }
  }
}

export async function uploadGeodataFile(
  file: File,
  metadata: UploadMetadata,
  options: UploadOptions,
): Promise<{ importRunId?: string; resumed: boolean }> {
  if (!file.size || file.size > MAX_UPLOAD_BYTES)
    throw new Error('Choose a non-empty file up to 1 GiB.');
  const { request, storage, signal } = options;
  const { key, legacyKey } = await storageKeys(file, metadata, options.ownerId);
  let saved = readSaved(storage, key);
  let session: UploadSession | undefined;
  let resumed = false;
  const report = (stage: UploadStage, uploadedBytes = 0) =>
    options.onProgress?.({
      stage,
      uploadedBytes,
      totalBytes: file.size,
      resumed,
    });
  report('PREPARING');
  // Migrate old browser state only after the API verifies ownership.
  const legacyId = !saved ? storage.getItem(legacyKey) : null;
  if (legacyId)
    saved = {
      uploadId: legacyId,
      idempotencyKey: legacyKey.split(':').at(-1)!,
      partSizeBytes: DEFAULT_PART_SIZE,
    };
  if (saved?.uploadId) {
    try {
      session = await request<UploadSession>(
        `/v1/geodata/import-uploads/${encodeURIComponent(saved.uploadId)}`,
        { signal },
      );
      if (['ABORTED', 'EXPIRED', 'FAILED'].includes(session.status)) {
        if (legacyId) storage.removeItem(legacyKey);
        session = undefined;
        saved = null;
      } else {
        resumed = true;
        storage.setItem(key, JSON.stringify(saved));
        if (legacyId) storage.removeItem(legacyKey);
      }
    } catch (error) {
      ensureActive(signal);
      if (!sessionUnavailable(error)) throw error;
      if (legacyId && httpStatus(error) === 400) storage.removeItem(legacyKey);
      saved = null;
    }
  }
  if (!saved) {
    saved = { idempotencyKey: crypto.randomUUID() };
    // Retain the attempt key before sending POST: a lost response must not
    // create a second multipart upload when the user retries.
    storage.setItem(key, JSON.stringify(saved));
  }
  if (!session) {
    ensureActive(signal);
    session = await request<UploadSession>('/v1/geodata/import-uploads', {
      method: 'POST',
      signal,
      headers: { 'Idempotency-Key': saved.idempotencyKey },
      body: JSON.stringify({
        ...metadata,
        filename: file.name,
        expectedSize: file.size,
      }),
    });
    if (!session.uploadId)
      throw new Error('The upload session could not be created.');
    saved.uploadId = session.uploadId;
    saved.partSizeBytes = session.partSizeBytes || DEFAULT_PART_SIZE;
    storage.setItem(key, JSON.stringify(saved));
    // A repeated create request may resolve to a session whose completion
    // response was lost, or whose parts reached the server before a pause.
    session = {
      ...session,
      ...(await request<UploadSession>(
        `/v1/geodata/import-uploads/${encodeURIComponent(session.uploadId)}`,
        { signal },
      )),
    };
  }
  if (session.expectedSize !== undefined && session.expectedSize !== file.size)
    throw new Error('Choose the original file to resume this upload.');
  const endpoint = `/v1/geodata/import-uploads/${encodeURIComponent(session.uploadId)}`;
  if (session.status === 'COMPLETED') {
    storage.removeItem(key);
    report('COMPLETE', file.size);
    return { importRunId: session.importRunId, resumed: true };
  }
  if (session.status !== 'COMPLETING') {
    const partSize = Number(
      session.partSizeBytes || saved.partSizeBytes || DEFAULT_PART_SIZE,
    );
    if (!Number.isSafeInteger(partSize) || partSize < 5 * 1024 * 1024)
      throw new Error('The server returned an invalid upload part size.');
    const received = new Map(
      (session.parts || []).map((part) => [part.partNumber, part]),
    );
    for (
      let start = 0, number = 1;
      start < file.size;
      start += partSize, number += 1
    ) {
      ensureActive(signal);
      report('UPLOADING', start);
      const end = Math.min(file.size, start + partSize);
      const part = file.slice(start, end);
      const checksum = await sha256(await part.arrayBuffer());
      ensureActive(signal);
      const existing = received.get(number);
      if (
        existing &&
        (existing.sizeBytes !== part.size ||
          existing.sha256.toLowerCase() !== checksum)
      ) {
        throw new Error(
          'This file differs from the interrupted upload. Select the original file or discard the upload and start again.',
        );
      }
      if (!existing) {
        await retryPart(
          () =>
            request(`${endpoint}/parts/${number}`, {
              method: 'POST',
              signal,
              body: part,
              headers: {
                'Content-Type': 'application/octet-stream',
                'X-Part-SHA256': checksum,
              },
            }),
          signal,
        );
      }
      report('UPLOADING', end);
    }
  }
  ensureActive(signal);
  report('VERIFYING', file.size);
  const result = await request<{ importRun?: { id: string } }>(
    `${endpoint}/complete`,
    {
      method: 'POST',
      signal,
      body: '{}',
    },
  );
  storage.removeItem(key);
  report('COMPLETE', file.size);
  return { importRunId: result.importRun?.id, resumed };
}

export async function discardGeodataUpload(
  file: File,
  metadata: UploadMetadata,
  options: UploadOptions,
): Promise<void> {
  const { key, legacyKey } = await storageKeys(file, metadata, options.ownerId);
  const saved = readSaved(options.storage, key);
  const uploadId = saved?.uploadId || options.storage.getItem(legacyKey);
  if (uploadId) {
    try {
      const endpoint = `/v1/geodata/import-uploads/${encodeURIComponent(uploadId)}`;
      const session = await options.request<UploadSession>(endpoint, {
        signal: options.signal,
      });
      if (session.status === 'COMPLETING') {
        throw new Error(
          'The server is checking this upload. Resume it to retrieve the import instead of discarding it.',
        );
      }
      if (session.status !== 'COMPLETED') {
        await options.request(endpoint, {
          method: 'DELETE',
          signal: options.signal,
        });
      }
      if (uploadId === options.storage.getItem(legacyKey))
        options.storage.removeItem(legacyKey);
    } catch (error) {
      if (!sessionUnavailable(error)) throw error;
    }
  }
  options.storage.removeItem(key);
  if (saved?.uploadId === options.storage.getItem(legacyKey))
    options.storage.removeItem(legacyKey);
}
