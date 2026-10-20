/** Contract-generated preferred resource client.
 *
 * Reads and uploads continue to use apiRequest directly; lifecycle writes go
 * through this façade so deprecated action routes cannot quietly return to the
 * admin UI during future edits.
 */
import { apiRequest } from './api';

const DELETION_REQUEST_TIMEOUT_MS = 15_000;

function deletionRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    DELETION_REQUEST_TIMEOUT_MS,
  );
  return apiRequest<T>(path, { ...options, signal: controller.signal }).finally(
    () => window.clearTimeout(timeout),
  );
}

function deletionWrite<T>(
  path: string,
  body: unknown,
  idempotencyKey: string = crypto.randomUUID(),
): Promise<T> {
  return deletionRequest<T>(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Idempotency-Key': idempotencyKey },
  });
}

function write<T>(
  path: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body: unknown = {},
  version?: number,
): Promise<T> {
  return apiRequest<T>(path, {
    method,
    body: JSON.stringify(body),
    headers: {
      'Idempotency-Key': crypto.randomUUID(),
      ...(version === undefined ? {} : { 'If-Match': `"${version}"` }),
    },
  });
}

export const myotaClient = {
  getAwardAssetContent<T = unknown>(id: string) {
    return apiRequest<T>(`/v1/awards/assets/${encodeURIComponent(id)}/content`);
  },
  putAwardAssetContent<T = unknown>(id: string, file: File) {
    return apiRequest<T>(
      `/v1/awards/assets/${encodeURIComponent(id)}/content`,
      { method: 'PUT', headers: { 'Content-Type': file.type }, body: file },
    );
  },
  createAwardPreview<T = unknown>(body: unknown) {
    return write<T>('/v1/awards/previews', 'POST', body);
  },
  patchProgramme<T = unknown>(slug: string, body: unknown) {
    return write<T>(
      `/v1/programmes/${encodeURIComponent(slug)}`,
      'PATCH',
      body,
    );
  },
  assignProgrammeEntityCategory<T = unknown>(slug: string, code: string) {
    return write<T>(
      `/v1/programmes/${encodeURIComponent(slug)}/entity-types/${encodeURIComponent(code)}`,
      'PUT',
    );
  },
  unassignProgrammeEntityCategory<T = unknown>(slug: string, code: string) {
    return write<T>(
      `/v1/programmes/${encodeURIComponent(slug)}/entity-types/${encodeURIComponent(code)}`,
      'DELETE',
    );
  },
  patchProgrammeContent<T = unknown>(slug: string, id: string, body: unknown) {
    return write<T>(
      `/v1/programmes/${encodeURIComponent(slug)}/content/${encodeURIComponent(id)}`,
      'PATCH',
      body,
    );
  },
  patchProgrammePolicyDraft<T = unknown>(
    slug: string,
    id: string,
    body: unknown,
  ) {
    return write<T>(
      `/v1/programmes/${encodeURIComponent(slug)}/policy-drafts/${encodeURIComponent(id)}`,
      'PATCH',
      body,
    );
  },
  patchIdentityAccount<T = unknown>(id: string, body: unknown) {
    return write<T>(
      `/v1/identity/accounts/${encodeURIComponent(id)}`,
      'PATCH',
      body,
    );
  },
  createIdentityAccount<T = unknown>(body: unknown) {
    return write<T>('/v1/identity/accounts', 'POST', body);
  },
  createIdentityRole<T = unknown>(body: unknown) {
    return write<T>('/v1/identity/roles', 'POST', body);
  },
  patchIdentityRole<T = unknown>(code: string, body: unknown) {
    return write<T>(
      `/v1/identity/roles/${encodeURIComponent(code)}`,
      'PATCH',
      body,
    );
  },
  patchGeodataEntityMetadata<T = unknown>(
    id: string,
    body: unknown,
    version?: number,
  ) {
    return write<T>(
      `/v1/geodata/entities/${encodeURIComponent(id)}`,
      'PATCH',
      body,
      version,
    );
  },
  postGeodataEntityLocationEnrichmentRequest<T = unknown>(
    id: string,
    body: unknown,
    version?: number,
  ) {
    return write<T>(
      `/v1/geodata/entities/${encodeURIComponent(id)}/location-enrichment-requests`,
      'POST',
      body,
      version,
    );
  },
  putGeodataEntityGeometry<T = unknown>(
    id: string,
    body: unknown,
    version?: number,
  ) {
    return write<T>(
      `/v1/geodata/entities/${encodeURIComponent(id)}/geometry`,
      'PUT',
      body,
      version,
    );
  },
  putGeodataEntityCategories<T = unknown>(
    id: string,
    body: unknown,
    version?: number,
  ) {
    return write<T>(
      `/v1/geodata/entities/${encodeURIComponent(id)}/categories`,
      'PUT',
      body,
      version,
    );
  },
  postGeodataEntityReview<T = unknown>(
    id: string,
    body: unknown,
    version?: number,
  ) {
    return write<T>(
      `/v1/geodata/entities/${encodeURIComponent(id)}/reviews`,
      'POST',
      body,
      version,
    );
  },
  postGeodataProposal<T = unknown>(body: unknown) {
    return write<T>('/v1/geodata/proposals', 'POST', body);
  },
  resolveGeodataConflation<T = unknown>(id: string, body: unknown) {
    return write<T>(
      `/v1/geodata/conflation/${encodeURIComponent(id)}/resolve`,
      'POST',
      body,
    );
  },
  createGeodataEntityDeletionJob<T = unknown>(
    body: unknown,
    idempotencyKey?: string,
  ) {
    return deletionWrite<T>(
      '/v1/geodata/entity-deletion-jobs',
      body,
      idempotencyKey,
    );
  },
  getGeodataEntityDeletionJob<T = unknown>(jobId: string) {
    return deletionRequest<T>(
      `/v1/geodata/entity-deletion-jobs/${encodeURIComponent(jobId)}`,
    );
  },
  confirmGeodataEntityDeletionJob<T = unknown>(jobId: string, body: unknown) {
    return deletionWrite<T>(
      `/v1/geodata/entity-deletion-jobs/${encodeURIComponent(jobId)}/confirm`,
      body,
    );
  },
  patchAward<T = unknown>(id: string, body: unknown) {
    return write<T>(`/v1/awards/${encodeURIComponent(id)}`, 'PATCH', body);
  },
};
