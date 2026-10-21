<script setup lang="ts">
import PageHeader from '../components/PageHeader.vue';
import PageNavigation from '../components/PageNavigation.vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { apiRequest } from '../lib/api';
import {
  canCancelPreprocessing,
  fetchPreprocessingQueue,
  importCounts,
  importStatusLabel,
  isPreprocessing,
  isReviewable,
} from '../lib/geodataImports';
import type { ImportPage, ImportRun } from '../lib/geodataImports';
import { discardGeodataUpload, uploadGeodataFile } from '../lib/geodataUploads';
import type {
  UploadMetadata,
  UploadProgress,
  UploadStage,
} from '../lib/geodataUploads';
import { useAppStore } from '../stores/app';
import LeafletMap from '../components/LeafletMap.vue';
import type { EntityCategory, GeoEntity } from '../types';

interface DuplicateMatch extends GeoEntity {
  entityId?: string;
  distanceMeters?: number;
  matchType?: string;
}
interface ImportCandidate {
  id: string;
  ordinal?: number;
  name?: string;
  geom?: { type: string; coordinates: unknown };
  geometry?: { type: string; coordinates: unknown };
  validationStatus?: string;
  targetStatus?: string;
  possibleDuplicate?: boolean;
  duplicateEntity?: DuplicateMatch;
  possibleDuplicates?: DuplicateMatch[];
}
interface CandidatePage {
  items: ImportCandidate[];
  total?: number;
  nextPage?: number | null;
}
interface ImportProcessingQueue {
  id: string;
  status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  result?: { errors?: Array<{ candidateId?: string; message?: string }> };
}

const store = useAppStore();
const categories = ref<EntityCategory[]>([]);
const imports = ref<ImportRun[]>([]);
const preprocessingRuns = ref<ImportRun[]>([]);
const selectedRun = ref<ImportRun | null>(null);
const candidates = ref<ImportCandidate[]>([]);
const selectedCandidateIds = ref<string[]>([]);
const page = ref(1);
const pageSize = 20;
const totalCandidates = ref(0);
const importPage = ref(1);
const importPageSize = 10;
const importTotal = ref(0);
const format = ref('GEOJSON');
const adapter = ref('MANUAL');
const entityType = ref('');
const filename = ref('');
const source = ref('MANUAL');
const sourceLicense = ref('');
const sourceAttribution = ref('');
const sourceUrl = ref('');
const content = ref('');
const file = ref<File | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const busy = ref(false);
const discarding = ref(false);
const actionBusy = ref(false);
const selectingAll = ref(false);
const refreshing = ref(false);
const message = ref('');
const error = ref('');
const refreshError = ref('');
const uploadStage = ref<UploadStage | 'PAUSED' | 'ERROR' | ''>('');
const uploadProgress = ref<UploadProgress | null>(null);
const formats = [
  'GEOJSON',
  'OSM_GEOJSON',
  'OSM_PBF',
  'KML',
  'GPX',
  'WFS',
  'ARCGIS_FEATURESERVER',
  'SHAPEFILE',
];
const allSelected = computed(
  () =>
    totalCandidates.value > 0 &&
    selectedCandidateIds.value.length === totalCandidates.value,
);
const selectedCounts = computed(() =>
  selectedRun.value ? importCounts(selectedRun.value) : null,
);
const showReview = computed(() =>
  Boolean(
    selectedRun.value &&
      selectedRun.value.status !== 'PROCESSED' &&
      !isPreprocessing(selectedRun.value) &&
      (isReviewable(selectedRun.value) || totalCandidates.value),
  ),
);
const canFinalize = computed(() =>
  Boolean(
    selectedRun.value &&
      selectedRun.value.status !== 'PROCESSED' &&
      !isPreprocessing(selectedRun.value) &&
      !actionBusy.value,
  ),
);
const uploadPercent = computed(() =>
  uploadProgress.value
    ? Math.round(
        (uploadProgress.value.uploadedBytes / uploadProgress.value.totalBytes) *
          100,
      )
    : 0,
);
const uploadLabel = computed(() => {
  if (discarding.value) return 'Discarding upload…';
  if (!busy.value)
    return uploadStage.value === 'PAUSED' || uploadStage.value === 'ERROR'
      ? 'Resume upload'
      : 'Queue preprocessing';
  if (!file.value) return 'Queuing dataset…';
  if (uploadStage.value === 'VERIFYING')
    return 'Checking file and queuing import…';
  if (uploadStage.value === 'PREPARING') return 'Preparing upload…';
  return `Uploading… ${uploadPercent.value}%`;
});
const candidateDetail = ref<ImportCandidate | null>(null);
const candidateMapEntities = ref<GeoEntity[]>([]);
const candidateActionStatus = ref('');
const candidateActionError = ref('');
const candidateReviewComplete = ref(false);
const candidateAdvancePending = ref(false);
const candidateActionKey = ref<string | null>(null);
const candidateActionQueueId = ref<string | null>(null);
const candidatePendingAction = ref<
  'CANDIDATE' | 'APPROVED' | 'REJECTED' | null
>(null);
const candidateDialog = ref<HTMLElement | null>(null);
const candidateInvoker = ref<HTMLElement | null>(null);
const pageController = new AbortController();
let uploadController: AbortController | null = null;
let uploadMetadata: UploadMetadata | null = null;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let lastQueueRefresh = 0;
let selectionVersion = 0;
let renderedCandidatePage = 0;
let renderedCandidateRunId = '';
let disposed = false;

function setError(value: unknown): void {
  error.value = value instanceof Error ? value.message : String(value);
}
function readApi<T>(path: string): Promise<T> {
  return apiRequest<T>(path, { signal: pageController.signal });
}
function metadata(): UploadMetadata {
  return {
    adapter:
      format.value === 'OSM_GEOJSON' || format.value === 'OSM_PBF'
        ? 'OSM'
        : adapter.value,
    format: format.value === 'OSM_GEOJSON' ? 'GEOJSON' : format.value,
    entityTypes: [entityType.value],
    source: {
      name: source.value,
      license: sourceLicense.value || 'Not specified',
      attribution: sourceAttribution.value,
      url: sourceUrl.value,
      retrievedAt: new Date().toISOString(),
    },
  };
}
function clearFile(): void {
  file.value = null;
  if (fileInput.value) fileInput.value.value = '';
  filename.value = '';
}
function chooseFile(event: Event): void {
  file.value = (event.target as HTMLInputElement).files?.[0] || null;
  if (file.value) filename.value = file.value.name;
  uploadStage.value = '';
  uploadProgress.value = null;
  uploadMetadata = null;
}
async function loadCategories(): Promise<void> {
  try {
    categories.value =
      (await readApi<{ items: EntityCategory[] }>('/v1/entity-types')).items ||
      [];
  } catch (cause) {
    if (!disposed) setError(cause);
  }
}
async function loadHistory(): Promise<void> {
  const requestedPage = importPage.value;
  const data = await readApi<ImportPage>(
    `/v1/geodata/imports?page=${requestedPage}&pageSize=${importPageSize}`,
  );
  if (disposed || importPage.value !== requestedPage) return;
  imports.value = data.items || [];
  importTotal.value = Number(data.total ?? imports.value.length);
  const lastPage = Math.max(1, Math.ceil(importTotal.value / importPageSize));
  if (importPage.value > lastPage) {
    importPage.value = lastPage;
    await loadHistory();
  }
}
async function loadCandidates(): Promise<void> {
  const id = selectedRun.value?.id;
  const requestedPage = page.value;
  const version = selectionVersion;
  if (!id || selectedRun.value?.status === 'PROCESSED') return;
  const data = await readApi<CandidatePage>(
    `/v1/geodata/imports/${encodeURIComponent(id)}/candidates?page=${requestedPage}&pageSize=${pageSize}`,
  );
  if (
    disposed ||
    selectedRun.value?.id !== id ||
    page.value !== requestedPage ||
    selectionVersion !== version
  )
    return;
  const previousIds = new Set(candidates.value.map((item) => item.id));
  const nextIds = new Set(data.items.map((item) => item.id));
  candidates.value = data.items;
  totalCandidates.value = Number(data.total ?? data.items.length);
  if (
    renderedCandidateRunId === id &&
    renderedCandidatePage === requestedPage
  ) {
    selectedCandidateIds.value = selectedCandidateIds.value.filter(
      (candidateId) =>
        !previousIds.has(candidateId) || nextIds.has(candidateId),
    );
  }
  renderedCandidateRunId = id;
  renderedCandidatePage = requestedPage;
  if (!totalCandidates.value) selectedCandidateIds.value = [];
  const lastPage = Math.max(1, Math.ceil(totalCandidates.value / pageSize));
  if (page.value > lastPage) {
    page.value = lastPage;
    await loadCandidates();
  }
}
async function fetchAllPendingCandidates(
  runId: string,
): Promise<ImportCandidate[]> {
  const result: ImportCandidate[] = [];
  let requestedPage = 1;
  while (true) {
    const data = await readApi<CandidatePage>(
      `/v1/geodata/imports/${encodeURIComponent(runId)}/candidates?page=${requestedPage}&pageSize=100`,
    );
    result.push(...(data.items || []));
    if (!data.nextPage) return result;
    requestedPage = data.nextPage;
  }
}
async function waitForPromotionQueue(
  runId: string,
  queueId: string,
  candidateId: string,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const queue = await readApi<ImportProcessingQueue>(
      `/v1/geodata/imports/${encodeURIComponent(runId)}/processing-queues/${encodeURIComponent(queueId)}`,
    );
    if (queue.status === 'COMPLETED') {
      const error = queue.result?.errors?.find(
        (item) => item.candidateId === candidateId,
      );
      if (error)
        throw new Error(
          error.message || 'Entity promotion failed. Retry this item.',
        );
      return;
    }
    if (queue.status === 'FAILED') {
      const error = queue.result?.errors?.find(
        (item) => item.candidateId === candidateId,
      );
      candidateActionKey.value = null;
      candidateActionQueueId.value = null;
      candidatePendingAction.value = null;
      throw new Error(
        error?.message || 'Entity promotion failed. Retry this item.',
      );
    }
    await new Promise<void>((resolve, reject) => {
      const finish = (): void => {
        pageController.signal.removeEventListener('abort', abort);
        resolve();
      };
      const timer = window.setTimeout(finish, 750);
      const abort = (): void => {
        window.clearTimeout(timer);
        pageController.signal.removeEventListener('abort', abort);
        reject(new DOMException('The page was closed.', 'AbortError'));
      };
      pageController.signal.addEventListener('abort', abort, { once: true });
    });
  }
  throw new Error(
    'Promotion is still running. Retry to check its status again.',
  );
}
async function advanceImportReview(
  runId: string,
  processed: ImportCandidate,
): Promise<void> {
  const pending = await fetchAllPendingCandidates(runId);
  if (pending.some((item) => item.id === processed.id)) {
    throw new Error(
      'The action completed, but this entity is still pending. Refresh the import and retry.',
    );
  }
  const currentOrdinal = processed.ordinal ?? -1;
  const next =
    pending.find((item) => (item.ordinal ?? -1) > currentOrdinal) || pending[0];
  await refreshImports(true);
  if (!next) {
    candidateReviewComplete.value = true;
    candidateAdvancePending.value = false;
    candidateActionStatus.value =
      'The last pending item in this import has been processed. You can close this map.';
    return;
  }
  page.value = Math.floor(pending.indexOf(next) / pageSize) + 1;
  await loadCandidates();
  openCandidate(next);
  candidateActionStatus.value = `Next item: ${next.name || 'Unnamed entity'}.`;
}
async function decideCandidate(
  action: 'CANDIDATE' | 'APPROVED' | 'REJECTED',
): Promise<void> {
  const runId = selectedRun.value?.id;
  const candidate = candidateDetail.value;
  if (
    !runId ||
    !candidate ||
    actionBusy.value ||
    candidateReviewComplete.value ||
    candidateAdvancePending.value
  )
    return;
  if (candidatePendingAction.value && candidatePendingAction.value !== action) {
    candidateActionError.value =
      'The previous action has no confirmed result. Retry that same action before choosing a different one.';
    return;
  }
  actionBusy.value = true;
  candidatePendingAction.value = action;
  let actionSucceeded = false;
  candidateActionError.value = '';
  candidateActionStatus.value =
    action === 'REJECTED'
      ? 'Rejecting entity…'
      : `Promoting entity to ${action.toLowerCase()}…`;
  try {
    if (action === 'REJECTED') {
      await apiRequest(
        `/v1/geodata/imports/${encodeURIComponent(runId)}/candidates/validate`,
        {
          method: 'POST',
          body: JSON.stringify({
            candidateIds: [candidate.id],
            validationStatus: 'REJECTED',
            reviewerId: store.account?.id,
          }),
          headers: {
            'Idempotency-Key':
              candidateActionKey.value ||
              (candidateActionKey.value = crypto.randomUUID()),
          },
        },
      );
    } else {
      if (!candidateActionKey.value)
        candidateActionKey.value = crypto.randomUUID();
      if (!candidateActionQueueId.value) {
        const queue = await apiRequest<ImportProcessingQueue>(
          `/v1/geodata/imports/${encodeURIComponent(runId)}/process`,
          {
            method: 'POST',
            body: JSON.stringify({
              candidateIds: [candidate.id],
              targetStatus: action,
              processorId: store.account?.id,
            }),
            headers: { 'Idempotency-Key': candidateActionKey.value },
          },
        );
        candidateActionQueueId.value = queue.id;
      }
      candidateActionStatus.value = 'Promotion queued. Waiting for the result…';
      const queueId = candidateActionQueueId.value;
      if (!queueId)
        throw new Error('Promotion queue was not returned by the service.');
      await waitForPromotionQueue(runId, queueId, candidate.id);
    }
    candidateActionKey.value = null;
    candidateActionQueueId.value = null;
    candidatePendingAction.value = null;
    actionSucceeded = true;
    candidateAdvancePending.value = true;
    await advanceImportReview(runId, candidate);
    candidateAdvancePending.value = false;
  } catch (cause) {
    if (actionSucceeded) {
      candidateActionStatus.value =
        'Decision completed. Continue to load the next pending item.';
      candidateActionError.value = `Could not load the next item: ${cause instanceof Error ? cause.message : String(cause)}`;
    } else {
      candidateActionStatus.value = '';
      candidateActionError.value =
        cause instanceof Error ? cause.message : String(cause);
    }
  } finally {
    actionBusy.value = false;
  }
}
async function continueImportReview(): Promise<void> {
  const runId = selectedRun.value?.id;
  const candidate = candidateDetail.value;
  if (
    !runId ||
    !candidate ||
    !candidateAdvancePending.value ||
    actionBusy.value
  )
    return;
  actionBusy.value = true;
  candidateActionError.value = '';
  try {
    await advanceImportReview(runId, candidate);
    candidateAdvancePending.value = false;
  } catch (cause) {
    candidateActionError.value = `Could not load the next item: ${cause instanceof Error ? cause.message : String(cause)}`;
  } finally {
    actionBusy.value = false;
  }
}
async function refreshSelected(): Promise<void> {
  const id = selectedRun.value?.id;
  const version = selectionVersion;
  if (!id) return;
  // Refresh relational candidate rows first; the detail response then projects
  // their latest counts, including records claimed by the separate worker.
  await loadCandidates();
  const detail = await readApi<ImportRun>(
    `/v1/geodata/imports/${encodeURIComponent(id)}`,
  );
  if (disposed || selectedRun.value?.id !== id || selectionVersion !== version)
    return;
  selectedRun.value = detail;
  if (detail.status === 'PROCESSED') {
    candidates.value = [];
    totalCandidates.value = 0;
    selectedCandidateIds.value = [];
  }
}
async function refreshImports(forceQueue = false): Promise<void> {
  if (refreshing.value || disposed) return;
  refreshing.value = true;
  try {
    await loadHistory();
    if (forceQueue || Date.now() - lastQueueRefresh >= 30_000) {
      preprocessingRuns.value = await fetchPreprocessingQueue(readApi);
      lastQueueRefresh = Date.now();
    }
    await refreshSelected();
    refreshError.value = '';
  } catch (cause) {
    if (!disposed)
      refreshError.value = `Could not refresh processing status: ${cause instanceof Error ? cause.message : String(cause)}`;
  } finally {
    refreshing.value = false;
  }
}
async function setImportPage(nextPage: number): Promise<void> {
  importPage.value = Math.min(
    Math.max(1, nextPage),
    Math.max(1, Math.ceil(importTotal.value / importPageSize)),
  );
  await refreshImports();
}
async function selectRun(run: ImportRun): Promise<void> {
  selectionVersion += 1;
  page.value = 1;
  selectedCandidateIds.value = [];
  candidates.value = [];
  totalCandidates.value = 0;
  selectedRun.value = run;
  try {
    await refreshSelected();
  } catch (cause) {
    if (!disposed) setError(cause);
  }
}
async function setCandidatePage(nextPage: number): Promise<void> {
  page.value = nextPage;
  try {
    await loadCandidates();
  } catch (cause) {
    if (!disposed) setError(cause);
  }
}
async function queueImport(): Promise<void> {
  if (busy.value) return;
  error.value = '';
  message.value = '';
  if (!entityType.value) {
    error.value = 'Select the entity category for this dataset.';
    return;
  }
  if (!file.value && !content.value.trim()) {
    error.value = 'Choose a file or paste source data.';
    return;
  }
  if (format.value === 'SHAPEFILE' && !file.value) {
    error.value = 'Choose a ZIP containing the Shapefile and its sidecars.';
    return;
  }
  if (format.value === 'OSM_PBF' && !file.value) {
    error.value = 'Choose an OSM PBF file to upload.';
    return;
  }
  if (
    file.value &&
    !['GEOJSON', 'OSM_GEOJSON', 'OSM_PBF', 'KML', 'GPX', 'SHAPEFILE'].includes(
      format.value,
    )
  ) {
    error.value = `${format.value} file uploads are not available yet. Paste its supported source data or choose a supported upload format.`;
    return;
  }
  busy.value = true;
  uploadController = new AbortController();
  let importRunId: string | undefined;
  try {
    const requestMetadata = uploadMetadata || metadata();
    if (file.value) {
      uploadMetadata = requestMetadata;
      const result = await uploadGeodataFile(file.value, requestMetadata, {
        ownerId: store.account?.id || '',
        request: apiRequest,
        storage: localStorage,
        signal: uploadController.signal,
        onProgress: (progress) => {
          uploadProgress.value = progress;
          uploadStage.value = progress.stage;
        },
      });
      importRunId = result.importRunId;
    } else {
      const run = await apiRequest<ImportRun>('/v1/geodata/imports', {
        method: 'POST',
        signal: uploadController.signal,
        body: JSON.stringify({
          ...requestMetadata,
          filename: filename.value || `pasted-${format.value.toLowerCase()}`,
          content: content.value,
        }),
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      });
      importRunId = run.id;
    }
    if (disposed) return;
    content.value = '';
    clearFile();
    uploadMetadata = null;
    sourceLicense.value = '';
    sourceAttribution.value = '';
    sourceUrl.value = '';
    message.value =
      'Dataset queued for preprocessing. Review its records when preprocessing finishes.';
    importPage.value = 1;
    await refreshImports(true);
    if (importRunId) await selectRun({ id: importRunId });
  } catch (cause) {
    if (disposed) return;
    if (uploadController.signal.aborted && file.value) {
      uploadStage.value = 'PAUSED';
      message.value =
        'Upload paused. Resume with the same file; completed parts are kept. After reopening this page, select the original file and use the same source, format and category settings to resume.';
    } else {
      uploadStage.value = file.value ? 'ERROR' : '';
      setError(cause);
    }
  } finally {
    busy.value = false;
    uploadController = null;
  }
}
function pauseUpload(): void {
  uploadController?.abort();
}
async function discardUpload(): Promise<void> {
  if (!file.value || busy.value) return;
  busy.value = true;
  discarding.value = true;
  try {
    await discardGeodataUpload(file.value, uploadMetadata || metadata(), {
      ownerId: store.account?.id || '',
      request: apiRequest,
      storage: localStorage,
      signal: pageController.signal,
    });
    clearFile();
    uploadMetadata = null;
    uploadStage.value = '';
    uploadProgress.value = null;
    error.value = '';
    message.value = 'Upload discarded. You can choose another file.';
  } catch (cause) {
    if (!disposed) setError(cause);
  } finally {
    busy.value = false;
    discarding.value = false;
  }
}
async function toggleAll(): Promise<void> {
  if (selectingAll.value || actionBusy.value) return;
  if (allSelected.value) {
    selectedCandidateIds.value = [];
    return;
  }
  const id = selectedRun.value?.id;
  const version = selectionVersion;
  if (!id) return;
  selectingAll.value = true;
  try {
    const ids: string[] = [];
    let nextPage: number | null | undefined = 1;
    while (nextPage) {
      const data: CandidatePage = await readApi<CandidatePage>(
        `/v1/geodata/imports/${encodeURIComponent(id)}/candidates?page=${nextPage}&pageSize=100`,
      );
      ids.push(...data.items.map((item) => item.id));
      nextPage = data.nextPage;
    }
    if (selectedRun.value?.id === id && selectionVersion === version)
      selectedCandidateIds.value = [...new Set(ids)];
  } catch (cause) {
    if (!disposed) setError(cause);
  } finally {
    selectingAll.value = false;
  }
}
function toggleCandidate(id: string): void {
  selectedCandidateIds.value = selectedCandidateIds.value.includes(id)
    ? selectedCandidateIds.value.filter((item) => item !== id)
    : [...selectedCandidateIds.value, id];
}
async function processCandidates(
  targetStatus: 'CANDIDATE' | 'APPROVED',
): Promise<void> {
  const id = selectedRun.value?.id;
  const ids = [...selectedCandidateIds.value];
  if (!id || !ids.length || actionBusy.value) return;
  actionBusy.value = true;
  error.value = '';
  try {
    await apiRequest(`/v1/geodata/imports/${encodeURIComponent(id)}/process`, {
      method: 'POST',
      body: JSON.stringify({
        candidateIds: ids,
        targetStatus,
        processorId: store.account?.id,
      }),
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    });
    if (selectedRun.value?.id === id) selectedCandidateIds.value = [];
    message.value = `${ids.length} records queued for promotion to ${targetStatus.toLowerCase()}. The counts update as processing finishes.`;
    await refreshImports(true);
  } catch (cause) {
    setError(cause);
  } finally {
    actionBusy.value = false;
  }
}
async function rejectCandidates(): Promise<void> {
  const id = selectedRun.value?.id;
  const ids = [...selectedCandidateIds.value];
  if (!id || !ids.length || actionBusy.value) return;
  actionBusy.value = true;
  error.value = '';
  try {
    await apiRequest(
      `/v1/geodata/imports/${encodeURIComponent(id)}/candidates/validate`,
      {
        method: 'POST',
        body: JSON.stringify({
          candidateIds: ids,
          validationStatus: 'REJECTED',
          reviewerId: store.account?.id,
        }),
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      },
    );
    if (selectedRun.value?.id === id) selectedCandidateIds.value = [];
    message.value = 'Rejected records were removed from the import.';
    await refreshImports(true);
  } catch (cause) {
    setError(cause);
  } finally {
    actionBusy.value = false;
  }
}
async function markProcessed(): Promise<void> {
  const id = selectedRun.value?.id;
  if (
    !id ||
    !canFinalize.value ||
    !window.confirm(
      'Finalize this import and permanently remove all remaining staged records, including confirmed records? Already promoted entities will remain.',
    )
  )
    return;
  actionBusy.value = true;
  try {
    const run = await apiRequest<ImportRun>(
      `/v1/geodata/imports/${encodeURIComponent(id)}/processed`,
      {
        method: 'POST',
        body: JSON.stringify({ processedBy: store.account?.id }),
      },
    );
    if (selectedRun.value?.id === id) {
      selectedRun.value = run;
      candidates.value = [];
      totalCandidates.value = 0;
      selectedCandidateIds.value = [];
    }
    message.value =
      'Import finalized. Its summary is retained; staged records have been removed.';
    await refreshImports(true);
  } catch (cause) {
    setError(cause);
  } finally {
    actionBusy.value = false;
  }
}
async function cancelPreprocessing(run: ImportRun): Promise<void> {
  if (!canCancelPreprocessing(run) || actionBusy.value) return;
  const confirmed = window.confirm(
    `Cancel preprocessing for “${run.filename || run.id}”? This removes the uploaded source and any staged pre-processing records. It cannot be undone.`,
  );
  if (!confirmed) return;
  actionBusy.value = true;
  error.value = '';
  try {
    const result = await apiRequest<ImportRun>(
      `/v1/geodata/imports/${encodeURIComponent(run.id)}/cancellation`,
      { method: 'PUT', body: JSON.stringify({}) },
    );
    if (selectedRun.value?.id === run.id) selectedRun.value = result;
    message.value =
      result.status === 'CANCELLING'
        ? 'Cancellation requested. The active worker will stop at its next safe checkpoint.'
        : 'Import cancelled. Its temporary source and staged records were removed.';
    await refreshImports(true);
  } catch (cause) {
    setError(cause);
  } finally {
    actionBusy.value = false;
  }
}
function duplicateMatches(item: ImportCandidate): DuplicateMatch[] {
  const matches = item.possibleDuplicates?.length
    ? item.possibleDuplicates
    : item.duplicateEntity
      ? [item.duplicateEntity]
      : [];
  return matches.map((match, index) => ({
    ...match,
    id: match.id || match.entityId || `${item.id}-duplicate-${index}`,
  }));
}
function candidateEntity(item: ImportCandidate): GeoEntity {
  return {
    id: item.id,
    name: item.name || 'Pre-processed entity',
    status: item.targetStatus || 'CANDIDATE',
    geometry: item.geometry || item.geom,
  };
}
function openCandidate(item: ImportCandidate, event?: MouseEvent): void {
  candidateInvoker.value =
    event?.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  candidateDetail.value = item;
  candidateMapEntities.value = [
    candidateEntity(item),
    ...duplicateMatches(item),
  ];
  candidateReviewComplete.value = false;
  candidateAdvancePending.value = false;
  candidateActionStatus.value = '';
  candidateActionError.value = '';
  candidateActionKey.value = null;
  candidateActionQueueId.value = null;
  candidatePendingAction.value = null;
  void nextTick(() =>
    candidateDialog.value
      ?.querySelector<HTMLElement>('button:not(:disabled)')
      ?.focus(),
  );
}
function closeCandidate(): void {
  if (actionBusy.value) return;
  candidateDetail.value = null;
  candidateMapEntities.value = [];
  candidateReviewComplete.value = false;
  candidateAdvancePending.value = false;
  candidateActionStatus.value = '';
  candidateActionError.value = '';
  candidateActionKey.value = null;
  candidateActionQueueId.value = null;
  candidatePendingAction.value = null;
  void nextTick(() => candidateInvoker.value?.focus());
}
function keepCandidateDialogKeyboardAccess(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeCandidate();
    return;
  }
  if (event.key !== 'Tab' || !candidateDialog.value) return;
  const controls = [
    ...candidateDialog.value.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((control) => control.offsetParent !== null);
  if (!controls.length) return;
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
function refreshWhenVisible(): void {
  if (!document.hidden && !actionBusy.value && !selectingAll.value)
    void refreshImports();
}
onMounted(async () => {
  await Promise.all([loadCategories(), refreshImports(true)]);
  if (disposed) return;
  pollTimer = setInterval(refreshWhenVisible, 5_000);
  document.addEventListener('visibilitychange', refreshWhenVisible);
});
onBeforeUnmount(() => {
  disposed = true;
  pageController.abort();
  uploadController?.abort();
  clearInterval(pollTimer);
  document.removeEventListener('visibilitychange', refreshWhenVisible);
});
</script>

<template>
  <PageHeader
    :refresh="() => refreshImports(true)"
    :busy="refreshing"
  ></PageHeader>
  <div v-if="message" class="notice" role="status">{{ message }}</div>
  <div v-if="error" class="error-card" role="alert">{{ error }}</div>
  <div v-if="refreshError" class="error-card" role="status">
    {{ refreshError }} Displayed results may be out of date.
  </div>

  <article class="panel">
    <div class="panel-heading">
      <div>
        <h2>Queue a dataset</h2>
        <p class="field-help">
          Files are uploaded first, then checked and preprocessed. Review the
          resulting records before creating candidate or approved entities.
        </p>
      </div>
    </div>
    <form @submit.prevent="queueImport">
      <fieldset
        class="form-grid import-inputs"
        :disabled="busy || uploadStage === 'PAUSED' || uploadStage === 'ERROR'"
      >
        <label
          >Format
          <select v-model="format">
            <option v-for="item in formats" :key="item" :value="item">
              {{ item }}
            </option>
          </select>
          <small class="field-help"
            >OSM GeoJSON and OSM PBF use the OpenStreetMap adapter
            automatically.</small
          >
        </label>
        <label
          >Adapter
          <select
            v-model="adapter"
            :disabled="format === 'OSM_GEOJSON' || format === 'OSM_PBF'"
          >
            <option value="MANUAL">Manual upload</option>
            <option value="OSM">OpenStreetMap</option>
            <option value="PARKSERVE_US">ParkServe US</option>
            <option value="GOVERNMENT_GIS">
              Government GIS / WFS / ArcGIS
            </option>
          </select>
        </label>
        <label
          >Feature category
          <select v-model="entityType" required>
            <option value="">Select a category…</option>
            <option
              v-for="category in categories"
              :key="category.code"
              :value="category.code"
            >
              {{ category.label || category.code }}
            </option>
          </select>
        </label>
        <label
          >Source label<input
            v-model="source"
            placeholder="OSM, municipal GIS, manual proposal…"
        /></label>
        <label
          >Licence<input v-model="sourceLicense" placeholder="e.g. ODbL 1.0"
        /></label>
        <label
          >Attribution<input
            v-model="sourceAttribution"
            placeholder="Required source attribution"
        /></label>
        <label class="wide"
          >Source URL<input
            v-model="sourceUrl"
            type="url"
            placeholder="https://…"
        /></label>
        <label class="wide"
          >Paste source document
          <textarea
            v-model="content"
            :placeholder="
              file
                ? `File selected: ${file.name}`
                : 'Paste GeoJSON, KML, GPX, WFS or ArcGIS JSON here'
            "
          ></textarea>
          <small class="field-help"
            >KML, GPX, WFS GeoJSON, and ArcGIS JSON can be pasted. KML and GPX
            files can also be uploaded.</small
          >
        </label>
        <label class="wide"
          >Upload file
          <input
            ref="fileInput"
            type="file"
            accept=".json,.geojson,.kml,.gpx,.zip,.pbf"
            @change="chooseFile"
          />
          <small class="field-help"
            >Files can be up to 1 GiB. The server may enforce a lower limit for
            the selected format. Shapefile archives may expand to 1 GiB.
            Imported features have configured size, vertex, and count limits.
            Shapefile ZIP archives must include matching .shp, .shx, and .dbf
            files. To resume an interrupted upload, choose the original file and
            the same import settings.</small
          >
          <small v-if="file" class="field-help"
            >Selected: {{ file.name }} ({{
              (file.size / 1024 / 1024).toFixed(1)
            }}
            MiB)</small
          >
        </label>
        <label v-if="!file"
          >Source filename<input
            v-model="filename"
            placeholder="dataset.geojson"
        /></label>
      </fieldset>
      <div
        v-if="uploadProgress"
        class="upload-progress"
        role="status"
        aria-live="polite"
      >
        <strong v-if="uploadStage === 'PREPARING'">Preparing upload…</strong>
        <strong v-else-if="uploadStage === 'VERIFYING'"
          >File uploaded. Checking it and queuing preprocessing…</strong
        >
        <strong v-else-if="uploadStage === 'PAUSED'"
          >Upload paused · {{ uploadPercent }}%</strong
        >
        <strong v-else-if="uploadStage === 'ERROR'"
          >Upload interrupted · {{ uploadPercent }}%</strong
        >
        <strong v-else-if="uploadStage === 'COMPLETE'"
          >Upload complete. Preprocessing runs separately.</strong
        >
        <strong v-else
          >{{ uploadProgress.resumed ? 'Resuming upload' : 'Uploading file' }} ·
          {{ uploadPercent }}%</strong
        >
        <progress
          v-if="uploadStage === 'VERIFYING'"
          aria-label="Checking uploaded file"
        ></progress>
        <progress
          v-else
          :value="uploadPercent"
          max="100"
          aria-label="File upload progress"
        ></progress>
        <small
          >{{ (uploadProgress.uploadedBytes / 1024 / 1024).toFixed(1) }} of
          {{ (uploadProgress.totalBytes / 1024 / 1024).toFixed(1) }} MiB
          uploaded</small
        >
      </div>
      <div class="form-actions import-upload-actions">
        <button class="primary" :disabled="busy" type="submit">
          {{ uploadLabel }}
        </button>
        <button
          v-if="busy && file && !discarding && uploadStage !== 'VERIFYING'"
          type="button"
          class="secondary"
          @click="pauseUpload"
        >
          Pause upload
        </button>
        <button
          v-if="file && !busy && ['PAUSED', 'ERROR'].includes(uploadStage)"
          type="button"
          class="secondary"
          @click="discardUpload"
        >
          Discard interrupted upload
        </button>
      </div>
    </form>
  </article>

  <div class="split-layout imports-workspace">
    <article class="panel import-queue-panel">
      <div class="panel-heading">
        <div>
          <h2>Pre-processing queue</h2>
          <small class="muted"
            >{{ preprocessingRuns.length }} files queued, processing or awaiting
            review</small
          >
        </div>
        <span class="status-pill queued">Separate from review</span>
      </div>
      <div class="table-list">
        <div
          v-for="run in preprocessingRuns"
          :key="run.id"
          class="table-row import-queue-row"
          :class="{ selected: selectedRun?.id === run.id }"
        >
          <button class="import-run-select" @click="selectRun(run)">
            <span
              ><strong>{{ run.filename || run.id }}</strong
              ><small
                >{{ run.format }} · {{ run.adapter }} ·
                {{
                  run.queuedAt ||
                  run.startedAt ||
                  run.createdAt ||
                  'Time unavailable'
                }}</small
              ></span
            >
            <span
              class="status-pill"
              :class="(run.status || '').toLowerCase()"
              >{{ importStatusLabel(run) }}</span
            >
          </button>
          <button
            v-if="canCancelPreprocessing(run)"
            class="danger-outline"
            :disabled="actionBusy"
            @click="cancelPreprocessing(run)"
          >
            Cancel
          </button>
        </div>
        <p v-if="!preprocessingRuns.length" class="muted empty">
          No imports are waiting for preprocessing or review.
        </p>
      </div>
      <p class="field-help">
        Status updates automatically while this page is visible.
      </p>
    </article>
    <article
      v-if="selectedRun && selectedCounts"
      class="panel import-detail-panel"
    >
      <div class="panel-heading">
        <div>
          <p class="eyebrow">IMPORT DETAIL</p>
          <h2>{{ selectedRun.filename || selectedRun.id }}</h2>
          <p class="muted">
            {{ importStatusLabel(selectedRun) }} ·
            {{ selectedCounts.source }} source records ·
            {{ totalCandidates }} pending records
          </p>
        </div>
        <div class="import-detail-actions">
          <button
            v-if="canCancelPreprocessing(selectedRun)"
            class="danger-outline"
            :disabled="actionBusy"
            @click="cancelPreprocessing(selectedRun)"
          >
            Cancel preprocessing
          </button>
          <button
            v-if="selectedRun.status !== 'PROCESSED'"
            class="secondary"
            :disabled="!canFinalize"
            @click="markProcessed"
          >
            Mark import as processed
          </button>
        </div>
      </div>
      <div class="info-grid">
        <div>
          <span>Status</span
          ><strong>{{ importStatusLabel(selectedRun) }}</strong>
        </div>
        <div>
          <span>Source records</span
          ><strong>{{ selectedCounts.source }}</strong>
        </div>
        <div>
          <span>Pending review</span><strong>{{ totalCandidates }}</strong>
        </div>
        <div>
          <span>Confirmed records</span
          ><strong>{{ selectedCounts.confirmed }}</strong>
        </div>
        <div>
          <span>Possible duplicate records</span
          ><strong>{{ selectedCounts.duplicates }}</strong>
        </div>
        <div>
          <span>Entities promoted</span
          ><strong>{{ selectedCounts.promoted }}</strong>
        </div>
        <div>
          <span>Errors</span><strong>{{ selectedCounts.errors }}</strong>
        </div>
        <div>
          <span>Source</span
          ><strong>{{
            typeof selectedRun.source === 'string'
              ? selectedRun.source
              : selectedRun.source?.name || '—'
          }}</strong>
        </div>
        <div>
          <span>Adapter</span><strong>{{ selectedRun.adapter || '—' }}</strong>
        </div>
        <div>
          <span>Latest activity</span
          ><strong>{{
            selectedRun.processedAt ||
            selectedRun.heartbeatAt ||
            selectedRun.completedAt ||
            selectedRun.updatedAt ||
            selectedRun.startedAt ||
            selectedRun.queuedAt ||
            '—'
          }}</strong>
        </div>
      </div>
      <p v-if="selectedCounts.duplicates > 0" class="notice" role="status">
        Possible duplicate locations were found. Open a flagged candidate to
        compare its geometry and match distance before promotion.
      </p>
      <p v-if="(selectedRun.attemptCount || 0) > 1" class="field-help">
        Processing attempt {{ selectedRun.attemptCount }}. Interrupted work is
        retried automatically.
      </p>
      <div v-if="selectedRun.lastError" class="error-card" role="status">
        {{ selectedRun.lastError }}
      </div>
      <div v-if="selectedRun.errors?.length" class="error-card">
        <strong>Record errors</strong>
        <div v-for="(item, index) in selectedRun.errors" :key="index">
          {{ typeof item === 'string' ? item : JSON.stringify(item) }}
        </div>
      </div>
      <p
        v-if="selectedRun.status === 'PREPROCESSED_WITH_ERRORS'"
        class="notice"
      >
        Valid records are available below. Only records that failed
        preprocessing were omitted.
      </p>
      <p
        v-if="
          ['UPLOAD_PENDING', 'QUEUED', 'PROCESSING'].includes(
            selectedRun.status || '',
          )
        "
        class="notice"
      >
        {{
          selectedRun.status === 'PROCESSING'
            ? 'Preprocessing is running.'
            : selectedRun.status === 'UPLOAD_PENDING'
              ? 'The upload is being handed off for preprocessing.'
              : 'This file is waiting for preprocessing.'
        }}
        Records will appear when preprocessing finishes. You can leave this page
        and return later.
      </p>
      <p v-if="selectedRun.status === 'CANCELLING'" class="notice">
        Cancellation requested. The worker will stop at a safe checkpoint and
        remove staged records and temporary source data.
      </p>
      <p v-if="selectedRun.status === 'CANCELLED'" class="notice">
        This import was cancelled. Its temporary upload and pre-processing
        records have been removed.
      </p>
      <p v-else-if="selectedRun.status === 'PROCESSED'" class="notice">
        This import has been finalized. Its summary is retained; staged records
        have been removed.
      </p>
      <p v-else-if="selectedCounts.confirmed" class="notice">
        {{ selectedCounts.confirmed }} confirmed records are waiting for or
        undergoing promotion. Counts update automatically as the worker
        finishes.
      </p>
      <template v-if="showReview">
        <h3>Review pre-processed records</h3>
        <div class="toolbar">
          <label class="check-field"
            ><input
              type="checkbox"
              :checked="allSelected"
              :disabled="selectingAll || actionBusy"
              @change="toggleAll"
            /><span>{{
              selectingAll ? 'Selecting all…' : 'Select all pending records'
            }}</span></label
          >
          <button
            class="secondary"
            :disabled="
              !selectedCandidateIds.length || actionBusy || selectingAll
            "
            @click="processCandidates('CANDIDATE')"
          >
            Promote selected to candidate
          </button>
          <button
            class="secondary"
            :disabled="
              !selectedCandidateIds.length || actionBusy || selectingAll
            "
            @click="processCandidates('APPROVED')"
          >
            Promote selected to approved
          </button>
          <button
            class="primary"
            :disabled="
              !selectedCandidateIds.length || actionBusy || selectingAll
            "
            @click="rejectCandidates"
          >
            Reject selected
          </button>
        </div>
        <p v-if="selectedCandidateIds.length" class="field-help">
          {{ selectedCandidateIds.length }} pending records selected across all
          pages.
        </p>
        <div class="candidate-list">
          <div v-for="item in candidates" :key="item.id" class="candidate-row">
            <input
              type="checkbox"
              :aria-label="`Select ${item.name || 'unnamed entity'}`"
              :checked="selectedCandidateIds.includes(item.id)"
              :disabled="actionBusy || selectingAll"
              @change="toggleCandidate(item.id)"
            />
            <button class="candidate-name" @click="openCandidate(item, $event)">
              {{ item.name || 'Unnamed entity' }}
            </button>
            <span>{{ item.validationStatus || 'PENDING' }}</span>
            <span
              v-if="item.possibleDuplicate || duplicateMatches(item).length"
              class="warning-pill"
              >Possible duplicate ({{ duplicateMatches(item).length }})</span
            >
            <small>{{
              item.geometry?.type || item.geom?.type || 'No geometry'
            }}</small>
          </div>
          <p v-if="!candidates.length" class="muted empty">
            No pending records for this import.
          </p>
        </div>
        <PageNavigation
          class="pagination"
          :page="page"
          :next-page="page * pageSize < totalCandidates ? page + 1 : null"
          :total="totalCandidates"
          count-label="pending records"
          :busy="actionBusy"
          label="import candidates"
          @change="setCandidatePage"
        />
      </template>
    </article>
    <article v-else class="panel empty-state import-detail-empty">
      <h2>Select an import</h2>
      <p class="muted">
        Click an import in the queue or history to inspect its processing status
        and pending records.
      </p>
    </article>
  </div>

  <article class="panel import-history-panel">
    <div class="panel-heading">
      <div>
        <h2>Import history</h2>
        <small class="muted"
          >{{ importPageSize }} imports per page ·
          {{ importTotal }} total</small
        >
      </div>
      <button
        class="secondary"
        :disabled="refreshing"
        @click="refreshImports(true)"
      >
        {{ refreshing ? 'Refreshing…' : 'Refresh status' }}
      </button>
    </div>
    <div class="table-list">
      <button
        v-for="run in imports"
        :key="run.id"
        class="table-row"
        :class="{ selected: selectedRun?.id === run.id }"
        @click="selectRun(run)"
      >
        <span
          ><strong>{{ run.filename || run.id }}</strong
          ><small
            >{{ run.format }} · {{ run.adapter }} ·
            {{ run.createdAt || run.queuedAt || 'Time unavailable' }}</small
          ></span
        >
        <span class="status-pill" :class="(run.status || '').toLowerCase()">{{
          importStatusLabel(run)
        }}</span>
      </button>
      <p v-if="!imports.length" class="muted empty">
        No imports have been queued.
      </p>
    </div>
    <PageNavigation
      class="pagination"
      :page="importPage"
      :next-page="
        importPage * importPageSize < importTotal ? importPage + 1 : null
      "
      :total="importTotal"
      count-label="imports"
      :busy="refreshing"
      label="imports"
      @change="setImportPage"
    />
  </article>

  <div
    v-if="candidateDetail"
    class="modal-backdrop"
    role="presentation"
    @click.self="closeCandidate"
  >
    <article
      ref="candidateDialog"
      class="modal-card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="candidate-preview-title"
      @keydown="keepCandidateDialogKeyboardAccess"
    >
      <div class="panel-heading">
        <div>
          <p class="eyebrow">PRE-PROCESSED RECORD</p>
          <h2 id="candidate-preview-title">
            {{ candidateDetail.name || 'Unnamed entity' }}
          </h2>
          <p class="muted">
            {{ candidateDetail.validationStatus || 'PENDING'
            }}<span v-if="duplicateMatches(candidateDetail).length">
              · Possible duplicate</span
            >
          </p>
        </div>
        <button class="quiet" :disabled="actionBusy" @click="closeCandidate">
          Close
        </button>
      </div>
      <p class="field-help">
        Compare the imported location with nearby existing entities.
      </p>
      <LeafletMap
        :entities="candidateMapEntities"
        :selected-id="candidateDetail.id"
        height="480px"
        :show-clusters="false"
      />
      <div
        v-for="duplicate in duplicateMatches(candidateDetail)"
        :key="duplicate.id"
        class="notice"
      >
        Possible duplicate: {{ duplicate.name
        }}<span v-if="duplicate.matchType"> · {{ duplicate.matchType }}</span
        ><span v-if="duplicate.distanceMeters != null">
          · {{ duplicate.distanceMeters }} m away</span
        ><span v-if="duplicate.entityId"> · {{ duplicate.entityId }}</span>
      </div>
      <p
        v-if="candidateActionStatus"
        class="notice"
        role="status"
        aria-live="polite"
      >
        {{ candidateActionStatus }}
      </p>
      <div v-if="candidateActionError" class="error-card" role="alert">
        {{ candidateActionError }}
      </div>
      <div v-if="candidateReviewComplete" class="form-actions">
        <button class="primary" @click="closeCandidate">Close review</button>
      </div>
      <div v-else-if="candidateAdvancePending" class="form-actions">
        <button
          class="primary"
          :disabled="actionBusy"
          @click="continueImportReview"
        >
          Continue to next item
        </button>
      </div>
      <div v-else class="map-actions" aria-label="Import review actions">
        <button
          class="secondary"
          :disabled="actionBusy"
          @click="decideCandidate('CANDIDATE')"
        >
          {{ actionBusy ? 'Processing…' : 'Promote to candidate' }}
        </button>
        <button
          class="approve"
          :disabled="actionBusy"
          @click="decideCandidate('APPROVED')"
        >
          Promote to approved
        </button>
        <button
          class="reject"
          :disabled="actionBusy"
          @click="decideCandidate('REJECTED')"
        >
          Reject entity
        </button>
      </div>
    </article>
  </div>
</template>
