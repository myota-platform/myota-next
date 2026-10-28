<script setup lang="ts">
import PageHeader from '../components/PageHeader.vue';
import PageNavigation from '../components/PageNavigation.vue';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router';
import { ApiError, apiRequest } from '../lib/api';
import { myotaClient } from '../lib/myotaClient';
import { createPendingIdempotencyKeys } from '../lib/pendingIdempotencyKeys';
import {
  pendingDeletionStatuses,
  pollDeletionJobs,
} from '../lib/deletionPolling';
import { hasAnyScope, canAdministerLocation } from '../lib/adminAccess';
import { useAppStore } from '../stores/app';
import LeafletMap from '../components/LeafletMap.vue';
import WorkspaceDialog from '../components/WorkspaceDialog.vue';
import { dirtyEditorSections } from '../lib/entityEditor';
import type { EntityCategory, GeoEntity } from '../types';

const props = defineProps<{ mode: 'review' | 'management' }>();
const isPendingDeletionStatus = (status: unknown) =>
  pendingDeletionStatuses.has(String(status).toUpperCase());
const store = useAppStore();
const pendingDeletionKeys = createPendingIdempotencyKeys(
  'myota_admin_pending_geodata_deletions',
);
const pendingEntityMutationKeys = createPendingIdempotencyKeys(
  'myota_admin_pending_geodata_entity_mutations',
);
const canEdit = computed(() => hasAnyScope(store.account, 'geodata.review'));
const canConvertGeometry = computed(
  () =>
    hasAnyScope(store.account, 'geodata.geometry.manage') ||
    store.account?.roles?.some((role) => role.role === 'GIS_ADMIN'),
);
const canEditLocation = computed(() => canAdministerLocation(store.account));
interface AuditEntry {
  action?: string;
  occurredAt?: string;
  editedAt?: string;
  note?: string;
  reviewerId?: string;
  editorId?: string;
  [key: string]: unknown;
}
interface AuditData {
  items?: AuditEntry[];
  reviewHistory?: AuditEntry[];
  geometryHistory?: AuditEntry[];
  statusHistory?: AuditEntry[];
}
interface DeletionImpact {
  qsoCount?: number;
  activationCount?: number;
  awardCount?: number;
}
interface LocationOption {
  name: string;
  code?: string | null;
  countries?: LocationOption[];
  subdivisions?: LocationOption[];
  provinces?: LocationOption[];
  cities?: LocationOption[];
}
const entities = ref<GeoEntity[]>([]);
const categories = ref<EntityCategory[]>([]);
const selected = ref<GeoEntity | null>(null);
const selectedIds = ref<string[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(25);
const loading = ref(false);
const error = ref('');
const message = ref('');
const audit = ref<AuditData>({});
const statuses = ['CANDIDATE', 'APPROVED', 'RETIRED', 'REJECTED'];
const filters = reactive({
  programme: '',
  status: [] as string[],
  entityType: '',
  continent: '',
  country: '',
  region: '',
  province: '',
  city: '',
});
const editName = ref('');
const editWebsite = ref('');
const editDescription = ref('');
const editNote = ref('');
const geometryNote = ref('');
const geometryJson = ref('');
const editTypes = ref<string[]>([]);
const geometryType = ref('');
const creating = ref(false);
const newName = ref('');
const newWebsite = ref('');
const newDescription = ref('');
const newTypes = ref<string[]>([]);
const newGeometry = ref(
  '{\n  "type": "Point",\n  "coordinates": [-5.99, 37.39]\n}',
);
const editingId = ref('');
const drawing = ref(false);
const drawingMode = ref<'POINT' | 'WAY' | 'POLYGON'>('POLYGON');
const editingLocation = ref(false);
const locationOptions = ref<LocationOption[]>([]);
const locationLoading = ref(false);
const locationManual = ref<string[]>([]);
const locationForm = reactive({
  continent: '',
  country: '',
  region: '',
  province: '',
  county: '',
  city: '',
  municipality: '',
  locality: '',
  continentCode: '',
  countryCode: '',
  regionCode: '',
  subdivisionCode: '',
  provinceCode: '',
  countyCode: '',
});
const locationEnrichmentSubmitting = ref(false);
const locationBackfill = reactive({
  running: false,
  cancelRequested: false,
  scanned: 0,
  total: 0,
  queued: 0,
  skipped: 0,
  failed: 0,
  status: '',
  firstFailure: '',
});
const locationEnrichmentPollIntervalMs = 2_000;
const isManagement = computed(() => props.mode === 'management');
const allSelected = computed(
  () =>
    entities.value.length > 0 &&
    entities.value.every((item) => selectedIds.value.includes(item.id)),
);
const isGlobalAdmin = computed(() => {
  const account = store.account as {
    roles?: Array<{ role?: string; scopes?: string[] } | string>;
    role?: string;
    scopes?: string[];
  } | null;
  const roles = account?.roles || [];
  return (
    roles.some((role) => {
      const roleName = typeof role === 'string' ? role : role.role;
      const scopes = typeof role === 'string' ? [] : role.scopes || [];
      return (
        ['GLOBAL_ADMIN', 'GLOBAL_OPERATOR'].includes(
          String(roleName || '').toUpperCase(),
        ) || scopes.includes('*')
      );
    }) ||
    ['GLOBAL_ADMIN', 'GLOBAL_OPERATOR'].includes(
      String(account?.role || '').toUpperCase(),
    ) ||
    (account?.scopes || []).includes('*')
  );
});
const selectedStatusOptions = computed(() =>
  ['APPROVED', 'RETIRED'].includes(selected.value?.status || '')
    ? ['RETIRED']
    : statuses,
);
const reviewStatus = ref('');
const title = computed(() =>
  isManagement.value ? 'Entity management' : 'Geodata review',
);
type EditorTab = 'details' | 'location' | 'geometry' | 'source' | 'audit';
const editorTabs: Array<{ id: EditorTab; label: string }> = [
  { id: 'details', label: 'Name & categories' },
  { id: 'location', label: 'Location' },
  { id: 'geometry', label: 'Geometry' },
  { id: 'source', label: 'Source comparison' },
  { id: 'audit', label: 'Audit & deletion' },
];
const editorOpen = ref(false);
const editorTab = ref<EditorTab>('details');
const editorSaving = ref(false);
const locationBaseline = ref('');
const geometryDrawing = ref(false);
const geometryMapEntities = ref<GeoEntity[]>([]);
const selectedIndex = computed(() =>
  entities.value.findIndex((item) => item.id === selected.value?.id),
);
const dirtySections = computed(() =>
  selected.value
    ? dirtyEditorSections(
        {
          name: selected.value.name,
          website: selected.value.website || '',
          description: selected.value.description || '',
          nameNote: '',
          categories: categoryCodes(selected.value),
          geometry: JSON.stringify(selected.value.geometry || {}, null, 2),
          geometryType: selected.value.geometry?.type || 'Point',
          geometryNote: '',
          location: locationBaseline.value,
        },
        {
          name: editName.value,
          website: editWebsite.value,
          description: editDescription.value,
          nameNote: editNote.value,
          categories: editTypes.value,
          geometry: geometryJson.value,
          geometryType: geometryType.value,
          geometryNote: geometryNote.value,
          location: editingLocation.value
            ? JSON.stringify([locationForm, locationManual.value])
            : locationBaseline.value,
        },
      )
    : [],
);

function canDiscardEdits(): boolean {
  return (
    !editorSaving.value &&
    (!dirtySections.value.length ||
      window.confirm(
        `Discard unsaved changes in ${dirtySections.value.join(', ')}?`,
      ))
  );
}
function closeEditor(): void {
  if (!canDiscardEdits()) return;
  editorOpen.value = false;
  editingId.value = '';
  geometryDrawing.value = false;
  if (selected.value) resetEditorFields(selected.value);
}
function setEditorTab(tab: EditorTab): void {
  editingId.value = '';
  geometryDrawing.value = false;
  editorTab.value = tab;
  if (tab === 'geometry' && selected.value) {
    try {
      geometryMapEntities.value = [
        { ...selected.value, geometry: JSON.parse(geometryJson.value) },
      ];
    } catch {
      geometryMapEntities.value = [selected.value];
    }
  }
}
function navigateEntity(offset: number): void {
  const entity = entities.value[selectedIndex.value + offset];
  if (selectedIndex.value >= 0 && entity) selectEntity(entity);
}
function guardNavigation(): boolean {
  if (locationBackfill.running) {
    locationBackfill.cancelRequested = true;
    locationBackfill.status =
      'Stopping the scan after the current request. Already queued work continues in the background.';
    return false;
  }
  return !isManagement.value || canDiscardEdits();
}
onBeforeRouteLeave(guardNavigation);
onBeforeRouteUpdate(guardNavigation);
watch(
  () => props.mode,
  () => {
    editorOpen.value = false;
    editingId.value = '';
    geometryDrawing.value = false;
    selected.value = null;
  },
);

const entityConflict = ref(false);
async function runGeodataMutation<T>(
  requestPath: string,
  requestBody: unknown,
  send: (idempotencyKey: string, body: unknown) => Promise<T>,
): Promise<T> {
  const body = JSON.parse(JSON.stringify(requestBody)) as unknown;
  const fingerprint = JSON.stringify([store.account?.id, requestPath, body]);
  const key = await pendingEntityMutationKeys.getOrCreate(fingerprint);
  const result = await send(key, body);
  await pendingEntityMutationKeys.complete(fingerprint);
  return result;
}
function setError(value: unknown): void {
  entityConflict.value = value instanceof ApiError && value.status === 409;
  error.value = value instanceof Error ? value.message : String(value);
}
async function reloadConflictedEntity(): Promise<void> {
  if (
    !window.confirm(
      'Reload the selected entity from the server? Unsaved edits will be discarded.',
    )
  )
    return;
  try {
    await refreshSelection();
    if (selected.value) resetEditorFields(selected.value);
    setEditorTab(editorTab.value);
    error.value = '';
    entityConflict.value = false;
  } catch (cause) {
    setError(cause);
  }
}
function categoryCodes(entity: GeoEntity): string[] {
  return (
    entity.entityTypes || (entity.entityType ? [entity.entityType] : [])
  ).map((item) => (typeof item === 'string' ? item : item.code));
}
function locationValue(entity: GeoEntity, key: string): string {
  return String(
    (entity as any)[key] ??
      entity.location?.[key] ??
      (key === 'region'
        ? ((entity as any).subdivision ?? entity.location?.subdivision)
        : '') ??
      '',
  );
}
function missingLocationFields(entity: GeoEntity): string[] {
  const manual = new Set((entity as any).manualLocationFields || []);
  const groups: Array<[string, string[]]> = [
    ['continent', ['continent']],
    ['continent code', ['continentCode']],
    ['country', ['country']],
    ['country code', ['countryCode']],
    ['region', ['region', 'subdivision']],
    ['subdivision code', ['regionCode', 'subdivisionCode']],
    ['city / municipality', ['city', 'municipality']],
  ];
  return groups.flatMap(([label, fields]) => {
    const hasValue = fields.some((field) =>
      Boolean((entity as any)[field] ?? entity.location?.[field]),
    );
    return hasValue || fields.some((field) => manual.has(field)) ? [] : [label];
  });
}
function sourceSnapshot(entity: GeoEntity): string {
  return JSON.stringify(
    entity.provenance?.sourceFeature || entity.provenance?.source || {},
    null,
    2,
  );
}
function auditEntries(): AuditEntry[] {
  const value = audit.value;
  return (
    value.items || [
      ...(value.reviewHistory || []),
      ...(value.geometryHistory || []),
      ...(value.statusHistory || []),
    ]
  ).sort((a, b) =>
    String(b.occurredAt || b.editedAt || '').localeCompare(
      String(a.occurredAt || a.editedAt || ''),
    ),
  );
}
function query(
  requestedPage = page.value,
  requestedPageSize = pageSize.value,
  scope = filters,
): string {
  const params = new URLSearchParams({
    page: String(requestedPage),
    pageSize: String(requestedPageSize),
  });
  if (scope.programme) params.set('programme', scope.programme);
  scope.status.forEach((status) => params.append('status', status));
  if (scope.entityType) params.set('entityType', scope.entityType);
  for (const key of ['continent', 'country', 'region', 'province', 'city']) {
    const value = scope[key as keyof typeof filters];
    if (typeof value === 'string' && value) params.set(key, value);
  }
  return params.toString();
}
async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const data = await apiRequest<{ items: GeoEntity[]; total?: number }>(
      `/v1/geodata/entities?${query()}`,
    );
    entities.value = data.items || [];
    total.value = Number(data.total ?? entities.value.length);
    if (
      !editorOpen.value &&
      selected.value &&
      !entities.value.some((item) => item.id === selected.value?.id)
    )
      selected.value = null;
  } catch (e) {
    setError(e);
  } finally {
    loading.value = false;
  }
}
async function loadCategories(): Promise<void> {
  try {
    const data = await apiRequest<{ items: EntityCategory[] }>(
      '/v1/entity-types',
    );
    categories.value = data.items || [];
  } catch (e) {
    setError(e);
  }
}
async function loadLocationOptions(): Promise<void> {
  locationLoading.value = true;
  try {
    const data = await apiRequest<{ continents: LocationOption[] }>(
      '/v1/geodata/location-options',
    );
    locationOptions.value = data.continents || [];
  } catch (e) {
    setError(e);
  } finally {
    locationLoading.value = false;
  }
}
function resetEditorFields(entity: GeoEntity): void {
  editingId.value = '';
  editingLocation.value = false;
  editName.value = entity.name;
  editWebsite.value = entity.website || '';
  editDescription.value = entity.description || '';
  editNote.value = '';
  geometryNote.value = '';
  geometryJson.value = JSON.stringify(entity.geometry || {}, null, 2);
  editTypes.value = categoryCodes(entity);
  geometryType.value = entity.geometry?.type || 'Point';
  reviewStatus.value = entity.status;
}
function selectEntity(entity: GeoEntity): void {
  if (
    isManagement.value &&
    selected.value &&
    selected.value.id !== entity.id &&
    !canDiscardEdits()
  )
    return;
  const changed = selected.value?.id !== entity.id;
  selected.value = entity;
  if (changed || !editorOpen.value) resetEditorFields(entity);
  if (isManagement.value) {
    editorOpen.value = true;
    setEditorTab(changed ? 'details' : editorTab.value);
  }
  loadAudit(entity.id);
}
async function refreshSelection(): Promise<void> {
  if (!selected.value) return;
  const id = selected.value.id;
  const entity = await apiRequest<GeoEntity>(
    `/v1/geodata/entities/${encodeURIComponent(id)}`,
  );
  if (selected.value?.id !== id) return;
  selected.value = entity;
  const index = entities.value.findIndex((item) => item.id === id);
  if (index >= 0) entities.value[index] = entity;
  await loadAudit(id);
}
async function loadAudit(id: string): Promise<void> {
  audit.value = {};
  try {
    const data = await apiRequest<AuditData>(
      `/v1/geodata/entities/${encodeURIComponent(id)}/audit`,
    );
    if (selected.value?.id === id) audit.value = data;
  } catch {
    if (selected.value?.id === id) audit.value = {};
  }
}
function toggleStatus(status: string): void {
  filters.status = filters.status.includes(status)
    ? filters.status.filter((item) => item !== status)
    : [...filters.status, status];
  page.value = 1;
  load();
}
function toggleAll(): void {
  selectedIds.value = allSelected.value
    ? []
    : entities.value.map((item) => item.id);
}
function toggleEntity(id: string): void {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((item) => item !== id)
    : [...selectedIds.value, id];
}
function statusEvent(event: Event): string {
  return (event.target as HTMLSelectElement).value;
}
async function saveStatus(status: string): Promise<void> {
  if (!selected.value) return;
  if (
    ['APPROVED', 'RETIRED'].includes(selected.value.status) &&
    status !== 'RETIRED'
  ) {
    error.value = `${selected.value.status} entities can only be retired.`;
    return;
  }
  if (status === selected.value.status) return;
  try {
    const id = selected.value.id;
    const version = selected.value.version;
    const requestPath = `/v1/geodata/entities/${encodeURIComponent(id)}/reviews`;
    const requestBody = {
      status,
      reviewerId: store.account?.id,
      note: editNote.value,
    };
    await runGeodataMutation(requestPath, requestBody, (idempotencyKey, body) =>
      myotaClient.postGeodataEntityReview(id, body, version, idempotencyKey),
    );
    message.value = `Status changed to ${status}.`;
    await load();
    const refreshed = entities.value.find(
      (item) => item.id === selected.value?.id,
    );
    if (refreshed) selectEntity(refreshed);
  } catch (e) {
    setError(e);
  }
}
async function bulkApprove(): Promise<void> {
  if (!selectedIds.value.length) return;
  try {
    const eligible = entities.value.filter(
      (entity) =>
        selectedIds.value.includes(entity.id) && entity.status === 'CANDIDATE',
    );
    if (!eligible.length) {
      message.value = 'No selected candidates are eligible for approval.';
      return;
    }
    const results = await Promise.allSettled(
      eligible.map((entity) => {
        const requestPath = `/v1/geodata/entities/${encodeURIComponent(entity.id)}/reviews`;
        const requestBody = {
          status: 'APPROVED',
          reviewerId: store.account?.id,
          note: 'Bulk approval from Geodata Review',
        };
        return runGeodataMutation(
          requestPath,
          requestBody,
          (idempotencyKey, body) =>
            myotaClient.postGeodataEntityReview(
              entity.id,
              body,
              entity.version,
              idempotencyKey,
            ),
        );
      }),
    );
    const failedIds = new Set(
      results.flatMap((result, index) =>
        result.status === 'rejected' ? [eligible[index].id] : [],
      ),
    );
    if (failedIds.size) {
      selectedIds.value = selectedIds.value.filter((id) => failedIds.has(id));
      const approvedCount = eligible.length - failedIds.size;
      message.value = `${approvedCount} candidates approved. Retry the remaining selected candidates.`;
      await load();
      throw new Error(
        `${failedIds.size} candidate approvals failed or need confirmation.`,
      );
    }
    message.value = `${eligible.length} candidates approved.`;
    selectedIds.value = [];
    await load();
  } catch (e) {
    setError(e);
  }
}
type DeletionJob = {
  id: string;
  status?: string;
  error?: string;
  impact?: DeletionImpact;
};
type DeletionItem = {
  entity: GeoEntity;
  job: DeletionJob;
  error?: string;
};
type PendingDeletion =
  | { kind: 'single'; entity: GeoEntity; job: DeletionJob }
  | {
      kind: 'bulk';
      items: DeletionItem[];
      totalCount: number;
      completedCount: number;
      impact: DeletionImpact;
    };
const deletionModal = ref<PendingDeletion | null>(null);
const deleting = ref(false);
const preparingBulkDelete = ref(false);
const bulkPreparationFailed = computed(
  () =>
    deletionModal.value?.kind === 'bulk' &&
    deletionModal.value.items.some(
      (item) => String(item.job.status).toUpperCase() === 'PREPARATION_FAILED',
    ),
);
function aggregateDeletionImpact(items: DeletionItem[]): DeletionImpact {
  return items.reduce<DeletionImpact>(
    (sum, item) => ({
      qsoCount: (sum.qsoCount || 0) + Number(item.job.impact?.qsoCount || 0),
      activationCount:
        (sum.activationCount || 0) +
        Number(item.job.impact?.activationCount || 0),
      awardCount:
        (sum.awardCount || 0) + Number(item.job.impact?.awardCount || 0),
    }),
    {},
  );
}
function deletionCreationFingerprint(entityId: string): string {
  const requestPath = '/v1/geodata/entity-deletion-jobs';
  const requestBody = { entityId, requestedBy: store.account?.id };
  return JSON.stringify([store.account?.id, requestPath, requestBody]);
}
function deletionConfirmationFingerprint(jobId: string): string {
  const requestPath = `/v1/geodata/entity-deletion-jobs/${encodeURIComponent(jobId)}/confirm`;
  const requestBody = { confirmation: 'DELETE', deletedBy: store.account?.id };
  return JSON.stringify([store.account?.id, requestPath, requestBody]);
}
async function createDeletionJob(id: string): Promise<DeletionJob> {
  const requestBody = { entityId: id, requestedBy: store.account?.id };
  const fingerprint = deletionCreationFingerprint(id);
  return myotaClient.createGeodataEntityDeletionJob<DeletionJob>(
    requestBody,
    await pendingDeletionKeys.getOrCreate(fingerprint),
  );
}
async function confirmDeletionJob(jobId: string): Promise<DeletionJob> {
  const requestBody = { confirmation: 'DELETE', deletedBy: store.account?.id };
  const fingerprint = deletionConfirmationFingerprint(jobId);
  return myotaClient.confirmGeodataEntityDeletionJob<DeletionJob>(
    jobId,
    requestBody,
    await pendingDeletionKeys.getOrCreate(fingerprint),
  );
}
async function completeDeletionKeys(
  entityId: string,
  jobId: string,
): Promise<void> {
  await Promise.all([
    pendingDeletionKeys.complete(deletionCreationFingerprint(entityId)),
    pendingDeletionKeys.complete(deletionConfirmationFingerprint(jobId)),
  ]);
}
const deletionPollDelayMs = 1_500;
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
async function refreshSingleDeletionStatus(
  pending: Extract<PendingDeletion, { kind: 'single' }>,
): Promise<void> {
  while (
    pendingDeletionStatuses.has(String(pending.job.status).toUpperCase())
  ) {
    try {
      pending.job = {
        ...pending.job,
        ...(await myotaClient.getGeodataEntityDeletionJob<DeletionJob>(
          pending.job.id,
        )),
      };
      pending.job.error =
        String(pending.job.status).toUpperCase() === 'FAILED'
          ? pending.job.error || 'Deletion job failed.'
          : undefined;
    } catch (cause) {
      pending.job.error =
        cause instanceof Error ? cause.message : String(cause);
    }
    if (pendingDeletionStatuses.has(String(pending.job.status).toUpperCase()))
      await delay(deletionPollDelayMs);
  }
}
async function refreshBulkDeletionStatuses(
  pending: Extract<PendingDeletion, { kind: 'bulk' }>,
): Promise<void> {
  const completedBeforePoll = pending.completedCount;
  await pollDeletionJobs({
    items: pending.items,
    jobFor: (item) => item.job,
    refresh: (jobId) =>
      myotaClient.getGeodataEntityDeletionJob<DeletionJob>(jobId),
    update: (item, job) => {
      item.job = { ...item.job, ...job };
      item.error =
        String(job.status).toUpperCase() === 'FAILED'
          ? job.error || 'Deletion job failed.'
          : undefined;
    },
    onError: (item, cause) => {
      item.error = cause instanceof Error ? cause.message : String(cause);
    },
    pause: () => delay(deletionPollDelayMs),
  });
  const completedItems = pending.items.filter(
    (item) => String(item.job.status).toUpperCase() === 'COMPLETED',
  );
  await Promise.all(
    completedItems.map((item) =>
      completeDeletionKeys(item.entity.id, item.job.id),
    ),
  );
  const completedIds = new Set(completedItems.map((item) => item.job.id));
  pending.items = pending.items.filter(
    (item) => !completedIds.has(item.job.id),
  );
  pending.completedCount = completedBeforePoll + completedIds.size;
  pending.impact = aggregateDeletionImpact(pending.items);
}
async function prepareDelete(id: string): Promise<void> {
  const entity =
    selected.value?.id === id
      ? selected.value
      : entities.value.find((item) => item.id === id);
  if (!entity || !isGlobalAdmin.value) return;
  try {
    deletionModal.value = {
      kind: 'single',
      entity,
      job: await createDeletionJob(id),
    };
  } catch (e) {
    setError(e);
  }
}
function cancelDelete(): void {
  if (deleting.value)
    message.value =
      'Confirmed deletion jobs continue in the background after this dialog closes.';
  deletionModal.value = null;
}
async function confirmDelete(): Promise<void> {
  const pending = deletionModal.value;
  if (!pending) return;
  if (
    pending.kind === 'bulk' &&
    (preparingBulkDelete.value || pending.items.some((item) => !item.job.id))
  ) {
    error.value =
      'Prepare deletion details for every selected entity before confirming.';
    return;
  }
  deleting.value = true;
  try {
    if (pending.kind === 'single') {
      if (String(pending.job.status).toUpperCase() === 'FAILED') {
        await completeDeletionKeys(pending.entity.id, pending.job.id);
        pending.job = await createDeletionJob(pending.entity.id);
      }
      if (
        !pendingDeletionStatuses.has(String(pending.job.status).toUpperCase())
      ) {
        try {
          pending.job = {
            ...pending.job,
            ...(await confirmDeletionJob(pending.job.id)),
          };
        } catch (cause) {
          const current =
            await myotaClient.getGeodataEntityDeletionJob<DeletionJob>(
              pending.job.id,
            );
          if (
            !pendingDeletionStatuses.has(
              String(current.status).toUpperCase(),
            ) &&
            String(current.status).toUpperCase() !== 'COMPLETED'
          )
            throw cause;
          pending.job = { ...pending.job, ...current };
        }
      }
      await refreshSingleDeletionStatus(pending);
      if (String(pending.job.status).toUpperCase() === 'COMPLETED') {
        await completeDeletionKeys(pending.entity.id, pending.job.id);
        message.value =
          'Entity permanently deleted; linked activity and award progress were reconciled.';
        deletionModal.value = null;
        selected.value = null;
        selectedIds.value = [];
        await load();
      } else if (String(pending.job.status).toUpperCase() === 'FAILED') {
        await pendingDeletionKeys.complete(
          deletionCreationFingerprint(pending.entity.id),
        );
        error.value =
          pending.job.error ||
          'Entity deletion failed. The entity was not reported as deleted.';
      } else {
        message.value =
          'Deletion is still processing. You can check its status again or close this dialog.';
      }
      return;
    } else {
      const submittedItems = [...pending.items];
      const results = await Promise.allSettled(
        submittedItems.map(async (item) => {
          if (String(item.job.status).toUpperCase() === 'FAILED') {
            await completeDeletionKeys(item.entity.id, item.job.id);
            item.job = await createDeletionJob(item.entity.id);
          }
          if (
            !item.job.status ||
            String(item.job.status).toUpperCase() === 'AWAITING_CONFIRMATION' ||
            String(item.job.status).toUpperCase() === 'FAILED'
          ) {
            try {
              item.job = {
                ...item.job,
                ...(await confirmDeletionJob(item.job.id)),
              };
            } catch (cause) {
              // A timeout can happen after the server has durably queued the job.
              // Read it back before treating the confirmation as failed.
              const current =
                await myotaClient.getGeodataEntityDeletionJob<DeletionJob>(
                  item.job.id,
                );
              if (
                !pendingDeletionStatuses.has(
                  String(current.status).toUpperCase(),
                ) &&
                String(current.status).toUpperCase() !== 'COMPLETED'
              )
                throw cause;
              item.job = { ...item.job, ...current };
            }
          }
          item.error = undefined;
          return item;
        }),
      );
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          const item = submittedItems[index];
          item.error =
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason);
        }
      });
      await refreshBulkDeletionStatuses(pending);
      selectedIds.value = selectedIds.value.filter((id) =>
        pending.items.some((item) => item.entity.id === id),
      );
      await load();
      const awaitingConfirmation = pending.items.some(
        (item) =>
          String(item.job.status).toUpperCase() === 'AWAITING_CONFIRMATION',
      );
      const failedItems = pending.items.filter(
        (item) => String(item.job.status).toUpperCase() === 'FAILED',
      );
      if (awaitingConfirmation) {
        message.value = `${pending.completedCount} of ${pending.totalCount} entities deleted. Some jobs still need confirmation; review and confirm again.`;
        error.value = pending.items.find((item) => item.error)?.error || '';
        return;
      }
      message.value = `${pending.completedCount} of ${pending.totalCount} entities were permanently deleted.`;
      if (failedItems.length) {
        error.value = failedItems
          .map(
            (item) =>
              `${item.entity.name}: ${item.error || item.job.error || 'Deletion failed.'}`,
          )
          .join(' · ');
      } else {
        message.value +=
          ' Linked QSOs were removed and award recalculation was queued.';
        error.value = '';
      }
      deletionModal.value = null;
      selected.value = null;
      selectedIds.value = [];
      await load();
      return;
    }
    deletionModal.value = null;
    selected.value = null;
    selectedIds.value = [];
    await load();
  } catch (e) {
    setError(e);
  } finally {
    deleting.value = false;
  }
}
async function deleteEntity(
  id: string,
  confirmAction = true,
  existingJob?: DeletionJob,
): Promise<void> {
  if (confirmAction) {
    await prepareDelete(id);
    return;
  }
  const entity =
    selected.value?.id === id
      ? selected.value
      : entities.value.find((item) => item.id === id);
  if (!entity || !existingJob) return;
  try {
    await confirmDeletionJob(existingJob.id);
    message.value =
      'Entity deletion queued; linked QSOs will be removed and award recalculation will run.';
    selected.value = null;
    await load();
  } catch (e) {
    setError(e);
  }
}
async function bulkDelete(): Promise<void> {
  const selectedEntities = entities.value.filter((entity) =>
    selectedIds.value.includes(entity.id),
  );
  if (!selectedEntities.length || !isGlobalAdmin.value) return;
  error.value = '';
  const pending: Extract<PendingDeletion, { kind: 'bulk' }> = {
    kind: 'bulk',
    items: selectedEntities.map((entity) => ({
      entity,
      job: { id: '', status: 'PREPARING' },
    })),
    totalCount: selectedEntities.length,
    completedCount: 0,
    impact: {},
  };
  // Render the stern confirmation modal before any network request. A failed
  // impact/job lookup must not make the bulk-delete action appear to do nothing.
  deletionModal.value = pending;
  await prepareBulkDeletionJobs(pending);
}
async function prepareBulkDeletionJobs(
  pending: Extract<PendingDeletion, { kind: 'bulk' }>,
): Promise<void> {
  preparingBulkDelete.value = true;
  try {
    const pendingItems = pending.items.filter(
      (item) =>
        !item.job.id ||
        String(item.job.status).toUpperCase() === 'PREPARATION_FAILED',
    );
    for (let offset = 0; offset < pendingItems.length; offset += 5) {
      const batch = pendingItems.slice(offset, offset + 5);
      await Promise.all(
        batch.map(async (item) => {
          try {
            item.job = await createDeletionJob(item.entity.id);
            item.error = undefined;
          } catch (cause) {
            item.job = { id: '', status: 'PREPARATION_FAILED' };
            item.error = cause instanceof Error ? cause.message : String(cause);
          }
        }),
      );
    }
    pending.impact = aggregateDeletionImpact(pending.items);
  } finally {
    preparingBulkDelete.value = false;
  }
}
async function retryBulkDeletionPreparation(): Promise<void> {
  const pending = deletionModal.value;
  if (pending?.kind === 'bulk') await prepareBulkDeletionJobs(pending);
}
async function saveEditorSection(
  section: string,
  update: () => Promise<unknown>,
): Promise<void> {
  if (editorSaving.value) return;
  editorSaving.value = true;
  error.value = '';
  try {
    await update();
    await refreshSelection();
    if (section === 'Name') editNote.value = '';
    if (section === 'Location') editingLocation.value = false;
    if (section === 'Geometry' && selected.value) {
      geometryJson.value = JSON.stringify(
        selected.value.geometry || {},
        null,
        2,
      );
      geometryType.value = selected.value.geometry?.type || 'Point';
      geometryNote.value = '';
      editingId.value = '';
      geometryDrawing.value = false;
      geometryMapEntities.value = [selected.value];
    }
    message.value = `${section} saved. Other unsaved sections are kept open.`;
    await load();
  } catch (cause) {
    setError(
      cause instanceof SyntaxError
        ? new Error('Geometry must be valid JSON.')
        : cause,
    );
  } finally {
    editorSaving.value = false;
  }
}
async function saveEntityDetails(): Promise<void> {
  const entity = selected.value;
  if (!entity || !canEdit.value || !editName.value.trim() || editorSaving.value)
    return;
  if (!validWebsite(editWebsite.value) || editDescription.value.length > 2000) {
    error.value =
      'Enter an absolute HTTP or HTTPS website up to 2,048 characters and a plain-text description up to 2,000 characters.';
    return;
  }
  const metadataChanged =
    editName.value.trim() !== entity.name ||
    (editWebsite.value.trim() || null) !== (entity.website || null) ||
    (editDescription.value.trim() || null) !== (entity.description || null);
  const categoriesChanged =
    JSON.stringify([...editTypes.value].sort()) !==
    JSON.stringify(categoryCodes(entity).sort());
  if (!metadataChanged && !categoriesChanged) return;

  editorSaving.value = true;
  error.value = '';
  message.value = '';
  let metadataSaved = false;
  try {
    if (metadataChanged) {
      const requestPath = `/v1/geodata/entities/${encodeURIComponent(entity.id)}`;
      const requestBody = {
        name: editName.value.trim(),
        website: editWebsite.value.trim() || null,
        description: editDescription.value.trim() || null,
        note: editNote.value,
        editorId: store.account?.id,
      };
      await runGeodataMutation(
        requestPath,
        requestBody,
        (idempotencyKey, body) =>
          myotaClient.patchGeodataEntityMetadata(
            entity.id,
            body,
            entity.version,
            idempotencyKey,
          ),
      );
      metadataSaved = true;
      await refreshSelection();
    }
    if (categoriesChanged && selected.value) {
      const selectedEntity = selected.value;
      const requestPath = `/v1/geodata/entities/${encodeURIComponent(selectedEntity.id)}/categories`;
      const requestBody = {
        entityTypes: editTypes.value,
        editorId: store.account?.id,
      };
      await runGeodataMutation(
        requestPath,
        requestBody,
        (idempotencyKey, body) =>
          myotaClient.putGeodataEntityCategories(
            selectedEntity.id,
            body,
            selectedEntity.version,
            idempotencyKey,
          ),
      );
      await refreshSelection();
    }
    editNote.value = '';
    message.value = 'Entity details saved.';
    await load();
  } catch (cause) {
    if (metadataSaved) {
      message.value = categoriesChanged
        ? 'Name and public details saved. Category changes remain unsaved; review and retry the details section.'
        : 'Name and public details were saved, but the latest entity state could not be reloaded.';
    }
    setError(cause);
  } finally {
    editorSaving.value = false;
  }
}
function validWebsite(value: string): boolean {
  const website = value.trim();
  if (!website) return true;
  if (website.length > 2048) return false;
  try {
    const url = new URL(website);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
function safeWebsite(value?: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
async function saveGeometry(): Promise<void> {
  const entity = selected.value;
  if (!entity || entity.status === 'RETIRED') return;
  await saveEditorSection('Geometry', () => {
    const geometry = JSON.parse(geometryJson.value);
    geometry.type = geometryType.value;
    const requestPath = `/v1/geodata/entities/${encodeURIComponent(entity.id)}/geometry`;
    const requestBody = {
      geometry,
      note: geometryNote.value,
      editorId: store.account?.id,
    };
    return runGeodataMutation(
      requestPath,
      requestBody,
      (idempotencyKey, body) =>
        myotaClient.putGeodataEntityGeometry(
          entity.id,
          body,
          entity.version,
          idempotencyKey,
        ),
    );
  });
}
function startGeometryEdit(): void {
  if (!selected.value?.geometry || selected.value.status === 'RETIRED') return;
  if (editorTab.value !== 'geometry' || !editorOpen.value)
    setEditorTab('geometry');
  editorOpen.value = true;
  geometryDrawing.value = false;
  editingId.value = selected.value.id;
}
function stopGeometryEdit(): void {
  editingId.value = '';
  geometryDrawing.value = false;
}
function onGeometryChange(geometry: {
  type: string;
  coordinates: unknown;
}): void {
  geometryJson.value = JSON.stringify(geometry, null, 2);
  geometryType.value = geometry.type;
}
function drawReplacement(mode: 'POINT' | 'WAY' | 'POLYGON'): void {
  editingId.value = '';
  drawingMode.value = mode;
  geometryDrawing.value = true;
}
function onGeometryDrawCreated(geometry: {
  type: string;
  coordinates: unknown;
}): void {
  onGeometryChange(geometry);
  geometryDrawing.value = false;
  if (selected.value)
    geometryMapEntities.value = [{ ...selected.value, geometry }];
}
function startDrawing(mode: 'POINT' | 'WAY' | 'POLYGON'): void {
  drawingMode.value = mode;
  drawing.value = true;
}
function onDrawCreated(geometry: { type: string; coordinates: unknown }): void {
  newGeometry.value = JSON.stringify(geometry, null, 2);
  drawing.value = false;
}
function fillLocationForm(entity: GeoEntity): void {
  for (const key of Object.keys(locationForm) as Array<
    keyof typeof locationForm
  >)
    locationForm[key] = locationValue(entity, key);
  locationManual.value = [
    ...(((entity as any).manualLocationFields || []) as string[]),
  ];
}
function uniqueLocationOptions(items: LocationOption[]): LocationOption[] {
  const seen = new Set<string>();
  return items
    .filter((item) => {
      const key = item.name.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
function selectedContinent(): LocationOption | undefined {
  return locationOptions.value.find((item) => item.name === filters.continent);
}
function locationCountries(): LocationOption[] {
  const continent = selectedContinent();
  return uniqueLocationOptions(
    continent
      ? continent.countries || []
      : locationOptions.value.flatMap((item) => item.countries || []),
  );
}
function selectedCountry(): LocationOption | undefined {
  return locationCountries().find((item) => item.name === filters.country);
}
function locationRegions(): LocationOption[] {
  const country = selectedCountry();
  return uniqueLocationOptions(
    country
      ? country.subdivisions || []
      : locationCountries().flatMap((item) => item.subdivisions || []),
  );
}
function selectedRegion(): LocationOption | undefined {
  return locationRegions().find((item) => item.name === filters.region);
}
function locationProvinces(): LocationOption[] {
  const region = selectedRegion();
  return uniqueLocationOptions(
    region
      ? region.provinces || []
      : locationRegions().flatMap((item) => item.provinces || []),
  );
}
function selectedProvince(): LocationOption | undefined {
  return locationProvinces().find((item) => item.name === filters.province);
}
function locationCities(): LocationOption[] {
  const province = selectedProvince();
  if (province?.cities?.length) return uniqueLocationOptions(province.cities);
  const region = selectedRegion();
  if (region?.cities?.length) return uniqueLocationOptions(region.cities);
  const country = selectedCountry();
  return uniqueLocationOptions(
    country
      ? country.cities || []
      : locationCountries().flatMap((item) => item.cities || []),
  );
}
function locationOptionLabel(item: LocationOption): string {
  return item.code ? `${item.name} (${item.code})` : item.name;
}
async function startLocationEdit(): Promise<void> {
  if (!selected.value) return;
  if (
    editingLocation.value &&
    !window.confirm('Discard unsaved location edits and reload?')
  )
    return;
  fillLocationForm(selected.value);
  locationBaseline.value = JSON.stringify([locationForm, locationManual.value]);
  if (!locationOptions.value.length) await loadLocationOptions();
  editingLocation.value = true;
}
function locationValues(field: string): LocationOption[] {
  if (field === 'continent') return locationOptions.value;
  const continent = locationOptions.value.find(
    (item) => item.name === locationForm.continent,
  );
  const countries =
    continent?.countries ||
    locationOptions.value.flatMap((item) => item.countries || []);
  if (field === 'country') return countries;
  const country = countries.find((item) => item.name === locationForm.country);
  const regions = country
    ? country.subdivisions || []
    : countries.flatMap((item) => item.subdivisions || []);
  if (field === 'region') return regions;
  const region = regions.find((item) => item.name === locationForm.region);
  return region
    ? region.provinces || []
    : regions.flatMap((item) => item.provinces || []);
}
function refreshLocationCodes(field: string): void {
  const match = locationValues(field).find(
    (item) => item.name === locationForm[field as keyof typeof locationForm],
  );
  if (field === 'continent') locationForm.continentCode = match?.code || '';
  if (field === 'country') locationForm.countryCode = match?.code || '';
  if (field === 'region') {
    locationForm.regionCode = match?.code || '';
    locationForm.subdivisionCode = match?.code || '';
  }
  if (field === 'province') locationForm.provinceCode = match?.code || '';
}
async function saveLocation(): Promise<void> {
  const entity = selected.value;
  if (!entity) return;
  const location = {
    ...locationForm,
    region: locationForm.region || null,
    subdivision: locationForm.region || null,
  };
  const requestPath = `/v1/geodata/entities/${encodeURIComponent(entity.id)}`;
  const requestBody = {
    location,
    manualFields: locationManual.value,
    editorId: store.account?.id,
  };
  await saveEditorSection('Location', () =>
    runGeodataMutation(requestPath, requestBody, (idempotencyKey, body) =>
      myotaClient.patchGeodataEntityMetadata(
        entity.id,
        body,
        entity.version,
        idempotencyKey,
      ),
    ),
  );
}
async function requestLocationEnrichment(): Promise<void> {
  if (!selected.value || !missingLocationFields(selected.value).length) return;
  locationEnrichmentSubmitting.value = true;
  error.value = '';
  try {
    const entity = selected.value;
    const requestPath = `/v1/geodata/entities/${encodeURIComponent(entity.id)}/location-enrichment-requests`;
    const requestBody = { editorId: store.account?.id };
    await runGeodataMutation(requestPath, requestBody, (idempotencyKey, body) =>
      myotaClient.postGeodataEntityLocationEnrichmentRequest(
        entity.id,
        body,
        entity.version,
        idempotencyKey,
      ),
    );
    message.value =
      'Location update queued. Results will be saved only if the entity geometry remains unchanged.';
    await refreshSelection();
  } catch (cause) {
    setError(cause);
  } finally {
    locationEnrichmentSubmitting.value = false;
  }
}
async function fillMissingLocationMetadata(): Promise<void> {
  if (!isManagement.value || !canEditLocation.value || locationBackfill.running)
    return;

  const scope = { ...filters, status: [...filters.status] };
  const pageSizeForBackfill = 100;
  let firstPage: { items: GeoEntity[]; total?: number };
  try {
    firstPage = await apiRequest<{ items: GeoEntity[]; total?: number }>(
      `/v1/geodata/entities?${query(1, pageSizeForBackfill, scope)}`,
    );
  } catch (cause) {
    setError(cause);
    return;
  }

  const matchingEntities = Number(firstPage.total ?? firstPage.items.length);
  if (!matchingEntities) {
    message.value = 'No matching entities to scan.';
    return;
  }
  if (
    !window.confirm(
      `Scan all ${matchingEntities} entities matching the current filters and queue asynchronous location enrichment only where metadata is missing? Existing queued requests will be skipped.`,
    )
  )
    return;

  Object.assign(locationBackfill, {
    running: true,
    cancelRequested: false,
    scanned: 0,
    total: matchingEntities,
    queued: 0,
    skipped: 0,
    failed: 0,
    status: 'Preparing location enrichment requests…',
    firstFailure: '',
  });
  message.value = '';

  try {
    const pageCount = Math.ceil(matchingEntities / pageSizeForBackfill);
    for (
      let requestedPage = 1;
      requestedPage <= pageCount;
      requestedPage += 1
    ) {
      if (locationBackfill.cancelRequested) break;
      const data =
        requestedPage === 1
          ? firstPage
          : await apiRequest<{ items: GeoEntity[]; total?: number }>(
              `/v1/geodata/entities?${query(requestedPage, pageSizeForBackfill, scope)}`,
            );

      for (const entity of data.items || []) {
        if (locationBackfill.cancelRequested) break;
        locationBackfill.scanned += 1;
        if (
          !entity.geometry ||
          !entity.geometry.coordinates ||
          !missingLocationFields(entity).length ||
          entity.locationEnrichmentStatus === 'QUEUED' ||
          entity.locationEnrichmentStatus === 'COMPLETED'
        ) {
          locationBackfill.skipped += 1;
        } else {
          const requestPath = `/v1/geodata/entities/${encodeURIComponent(entity.id)}/location-enrichment-requests`;
          const requestBody = { editorId: store.account?.id };
          try {
            await runGeodataMutation(
              requestPath,
              requestBody,
              (idempotencyKey, body) =>
                myotaClient.postGeodataEntityLocationEnrichmentRequest(
                  entity.id,
                  body,
                  entity.version,
                  idempotencyKey,
                ),
            );
            locationBackfill.queued += 1;
          } catch (cause) {
            if (cause instanceof ApiError && cause.status === 409) {
              locationBackfill.skipped += 1;
            } else {
              locationBackfill.failed += 1;
              if (!locationBackfill.firstFailure)
                locationBackfill.firstFailure =
                  cause instanceof Error ? cause.message : String(cause);
            }
          }
        }
        locationBackfill.status = `Scanned ${locationBackfill.scanned} of ${locationBackfill.total} matching entities · queued ${locationBackfill.queued} · skipped ${locationBackfill.skipped} · failed ${locationBackfill.failed}.`;
      }
    }
    const stopped = locationBackfill.cancelRequested;
    locationBackfill.status = `${stopped ? 'Stopped' : 'Finished'} after scanning ${locationBackfill.scanned} of ${locationBackfill.total} matching entities · queued ${locationBackfill.queued} · skipped ${locationBackfill.skipped} · failed ${locationBackfill.failed}.`;
    if (locationBackfill.failed)
      locationBackfill.status +=
        ' Run the action again to retry entities that remain incomplete.';
    if (stopped)
      locationBackfill.status +=
        ' Already queued requests continue in the background.';
    await load();
    if (selected.value) await refreshSelection();
  } catch (cause) {
    locationBackfill.status = `Stopped after scanning ${locationBackfill.scanned} of ${locationBackfill.total} matching entities · queued ${locationBackfill.queued} · skipped ${locationBackfill.skipped} · failed ${locationBackfill.failed}.`;
    locationBackfill.firstFailure =
      cause instanceof Error ? cause.message : String(cause);
  } finally {
    locationBackfill.running = false;
  }
}
function toggleNewType(code: string): void {
  newTypes.value = newTypes.value.includes(code)
    ? newTypes.value.filter((item) => item !== code)
    : [...newTypes.value, code];
}
async function createCandidate(): Promise<void> {
  if (!newName.value.trim() || !newTypes.value.length) {
    error.value = 'Enter a name and select at least one category.';
    return;
  }
  if (!validWebsite(newWebsite.value) || newDescription.value.length > 2000) {
    error.value =
      'Enter an absolute HTTP or HTTPS website up to 2,048 characters and a plain-text description up to 2,000 characters.';
    return;
  }
  try {
    const geometry = JSON.parse(newGeometry.value);
    const requestPath = '/v1/geodata/proposals';
    const requestBody = {
      source: {
        name: 'Manual administration proposal',
        license: 'programme-supplied',
      },
      proposerId: store.account?.id,
      entityTypes: newTypes.value,
      feature: {
        type: 'Feature',
        properties: {
          name: newName.value.trim(),
          website: newWebsite.value.trim() || null,
          description: newDescription.value.trim() || null,
        },
        geometry,
      },
    };
    await runGeodataMutation(requestPath, requestBody, (idempotencyKey, body) =>
      myotaClient.postGeodataProposal(body, idempotencyKey),
    );
    message.value = 'New candidate submitted.';
    creating.value = false;
    newName.value = '';
    newWebsite.value = '';
    newDescription.value = '';
    newTypes.value = [];
    await load();
  } catch (e) {
    setError(
      e instanceof SyntaxError ? new Error('Geometry must be valid JSON.') : e,
    );
  }
}
function setPage(next: number): void {
  page.value = next;
  load();
}
watch(
  () => filters.continent,
  () => {
    filters.country = '';
    filters.region = '';
    filters.province = '';
    filters.city = '';
  },
);
watch(
  () => filters.country,
  () => {
    filters.region = '';
    filters.province = '';
    filters.city = '';
  },
);
watch(
  () => filters.region,
  () => {
    filters.province = '';
    filters.city = '';
  },
);
watch(
  () => filters.province,
  () => {
    filters.city = '';
  },
);
watch(
  [
    () => isManagement.value,
    () => selected.value?.id,
    () => selected.value?.locationEnrichmentStatus,
  ],
  ([management, entityId, status], _previous, onCleanup) => {
    if (!management || !entityId || status !== 'QUEUED') return;

    let active = true;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const refreshed = await apiRequest<GeoEntity>(
          `/v1/geodata/entities/${encodeURIComponent(entityId)}`,
        );
        if (!active || selected.value?.id !== entityId) return;

        selected.value = { ...selected.value, ...refreshed };
        const listIndex = entities.value.findIndex(
          (item) => item.id === entityId,
        );
        if (listIndex >= 0) {
          entities.value[listIndex] = {
            ...entities.value[listIndex],
            ...refreshed,
          };
        }

        if (refreshed.locationEnrichmentStatus === 'COMPLETED') {
          message.value = 'Location metadata updated.';
          error.value = '';
        } else if (refreshed.locationEnrichmentStatus === 'FAILED') {
          message.value =
            'The location lookup failed. Existing metadata was preserved; you can retry.';
        }
      } catch {
        // Keep polling through transient API/network errors while this entity
        // remains selected; the worker continues independently.
      }

      if (
        active &&
        selected.value?.id === entityId &&
        selected.value.locationEnrichmentStatus === 'QUEUED'
      ) {
        timer = window.setTimeout(poll, locationEnrichmentPollIntervalMs);
      }
    };

    timer = window.setTimeout(poll, locationEnrichmentPollIntervalMs);
    onCleanup(() => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    });
  },
);
watch(
  () => [
    pageSize.value,
    filters.programme,
    filters.entityType,
    filters.continent,
    filters.country,
    filters.region,
    filters.province,
    filters.city,
  ],
  () => {
    page.value = 1;
    load();
  },
);
onMounted(async () => {
  await Promise.all([loadCategories(), loadLocationOptions(), load()]);
});
</script>

<template>
  <PageHeader :refresh="() => load()" :busy="loading"
    ><button class="primary" @click="creating = !creating">
      New Candidate
    </button></PageHeader
  >
  <div v-if="message" class="notice" role="status">{{ message }}</div>
  <div v-if="error" class="error-card" role="alert">
    {{ error }}
    <button
      v-if="entityConflict && selected"
      class="secondary"
      @click="reloadConflictedEntity"
    >
      Reload selected entity
    </button>
  </div>
  <article class="panel filter-panel">
    <div class="top-controls">
      <label
        >Programme<select v-model="filters.programme">
          <option value="">All programmes, including unassigned</option>
          <option
            v-for="programme in store.programmes"
            :key="programme.slug"
            :value="programme.slug"
          >
            {{ programme.name }}
          </option>
        </select></label
      >
    </div>
    <div class="geo-filter-grid">
      <label
        >Entity type<select v-model="filters.entityType">
          <option value="">All types</option>
          <option
            v-for="category in categories"
            :key="category.code"
            :value="category.code"
          >
            {{ category.label || category.code }}
          </option>
        </select></label
      ><label
        >Continent<select
          v-model="filters.continent"
          :disabled="locationLoading"
        >
          <option value="">All continents</option>
          <option
            v-for="item in locationOptions"
            :key="`${item.code || ''}-${item.name}`"
            :value="item.name"
          >
            {{ locationOptionLabel(item) }}
          </option>
        </select></label
      ><label
        >Country<select
          v-model="filters.country"
          :disabled="locationLoading || !locationCountries().length"
        >
          <option value="">All countries</option>
          <option
            v-for="item in locationCountries()"
            :key="`${item.code || ''}-${item.name}`"
            :value="item.name"
          >
            {{ locationOptionLabel(item) }}
          </option>
        </select></label
      ><label
        >Region / subdivision<select
          v-model="filters.region"
          :disabled="locationLoading || !locationRegions().length"
        >
          <option value="">All regions / subdivisions</option>
          <option
            v-for="item in locationRegions()"
            :key="`${item.code || ''}-${item.name}`"
            :value="item.name"
          >
            {{ locationOptionLabel(item) }}
          </option>
        </select></label
      ><label
        >Province<select
          v-model="filters.province"
          :disabled="locationLoading || !locationProvinces().length"
        >
          <option value="">All provinces</option>
          <option
            v-for="item in locationProvinces()"
            :key="`${item.code || ''}-${item.name}`"
            :value="item.name"
          >
            {{ locationOptionLabel(item) }}
          </option>
        </select></label
      ><label
        >City / municipality<select
          v-model="filters.city"
          :disabled="locationLoading || !locationCities().length"
        >
          <option value="">All cities / municipalities</option>
          <option
            v-for="item in locationCities()"
            :key="item.name"
            :value="item.name"
          >
            {{ item.name }}
          </option>
        </select></label
      >
    </div>
    <div class="status-filters">
      <span>Status:</span
      ><label v-for="status in statuses" :key="status"
        ><input
          type="checkbox"
          :checked="filters.status.includes(status)"
          @change="toggleStatus(status)"
        />{{ status }}</label
      >
    </div>
  </article>
  <article v-if="creating" class="panel">
    <div class="panel-heading">
      <div>
        <p class="eyebrow">MANUAL PROPOSAL</p>
        <h2>New Candidate</h2>
        <p class="muted">
          Manual proposals enter the candidate queue and are not approved
          automatically.
        </p>
      </div>
    </div>
    <form class="form-grid" @submit.prevent="createCandidate">
      <label>Name<input v-model="newName" maxlength="240" required /></label
      ><label
        >Website<input
          v-model="newWebsite"
          type="url"
          maxlength="2048"
          placeholder="https://example.org"
        /><small class="field-help"
          >Optional HTTP or HTTPS address.</small
        ></label
      ><label class="wide"
        >Description<textarea
          v-model="newDescription"
          maxlength="2000"
          placeholder="Plain text"
        ></textarea></label
      ><label
        >Programme scope<select v-model="filters.programme">
          <option value="">Unassigned / platform-wide</option>
          <option
            v-for="programme in store.programmes"
            :key="programme.slug"
            :value="programme.slug"
          >
            {{ programme.name }}
          </option>
        </select></label
      >
      <fieldset class="wide">
        <legend>Entity categories</legend>
        <div class="checkbox-grid">
          <label v-for="category in categories" :key="category.code"
            ><input
              type="checkbox"
              :checked="newTypes.includes(category.code)"
              @change="toggleNewType(category.code)"
            />{{ category.label || category.code }}</label
          >
        </div>
      </fieldset>
      <div class="form-actions wide">
        <button class="secondary" type="button" @click="startDrawing('POINT')">
          Draw point on map</button
        ><button class="secondary" type="button" @click="startDrawing('WAY')">
          Draw way / trail</button
        ><button
          class="secondary"
          type="button"
          @click="startDrawing('POLYGON')"
        >
          Draw polygon
        </button>
      </div>
      <label class="wide"
        >GeoJSON geometry<textarea
          v-model="newGeometry"
          class="code-editor"
          required
        ></textarea
        ><small class="field-help"
          >Use the map buttons for interactive drawing, or enter a Point,
          LineString, MultiLineString, Polygon or MultiPolygon geometry.</small
        ></label
      >
      <div class="form-actions wide">
        <button class="primary" type="submit">Submit candidate</button
        ><button
          class="secondary"
          type="button"
          @click="
            creating = false;
            drawing = false;
          "
        >
          Cancel
        </button>
      </div>
    </form>
  </article>
  <article class="panel">
    <div class="panel-heading">
      <div>
        <h2>Entities</h2>
        <small class="muted"
          >{{ total }} matching entities · page {{ page }}</small
        >
      </div>
      <div class="toolbar">
        <label
          >Show
          <select v-model.number="pageSize">
            <option :value="25">25</option>
            <option :value="50">50</option>
            <option :value="100">100</option>
          </select></label
        ><label class="check-field"
          ><input
            type="checkbox"
            :checked="allSelected"
            @change="toggleAll"
          /><span>Select all</span></label
        ><button
          v-if="isManagement && canEditLocation"
          class="secondary"
          :disabled="locationBackfill.running || loading || !total"
          @click="fillMissingLocationMetadata"
        >
          {{
            locationBackfill.running
              ? 'Queueing location updates…'
              : 'Fill missing location metadata from entities'
          }}</button
        ><button
          v-if="locationBackfill.running"
          class="secondary"
          @click="locationBackfill.cancelRequested = true"
        >
          Stop queueing</button
        ><button
          v-if="!isManagement"
          class="primary"
          :disabled="!selectedIds.length"
          @click="bulkApprove"
        >
          Change status to approved</button
        ><button
          v-if="isGlobalAdmin"
          class="danger"
          :disabled="!selectedIds.length || deleting || preparingBulkDelete"
          @click="bulkDelete"
        >
          {{
            preparingBulkDelete
              ? 'Preparing deletion…'
              : 'Permanently delete entities'
          }}
        </button>
      </div>
    </div>
    <p
      v-if="locationBackfill.status"
      class="field-help"
      role="status"
      aria-live="polite"
    >
      {{ locationBackfill.status }}
      <span v-if="locationBackfill.firstFailure">
        First error: {{ locationBackfill.firstFailure }}
      </span>
    </p>
    <div class="geo-list">
      <div
        v-for="entity in entities"
        :key="entity.id"
        class="geo-row"
        :class="{ selected: selected?.id === entity.id }"
      >
        <input
          type="checkbox"
          :aria-label="`Select ${entity.name}`"
          :checked="selectedIds.includes(entity.id)"
          @change="toggleEntity(entity.id)"
        /><button class="entity-link" @click="selectEntity(entity)">
          <strong>{{ entity.name }}</strong
          ><small
            >{{ entity.entityIdentifier || 'No programme ID' }} ·
            {{ categoryCodes(entity).join(', ') || 'Uncategorised' }} ·
            {{ locationValue(entity, 'city') || 'Location unavailable' }}</small
          ><small v-if="entity.website || entity.description"
            >{{ entity.website || 'No website'
            }}<template v-if="entity.description">
              · {{ entity.description }}</template
            ></small
          ><small class="locator-values"
            >4-character grid squares:
            {{ entity.maidenheadGridSquares4?.join(', ') || '—' }} · 6-character
            locators: {{ entity.maidenheadLocators6?.join(', ') || '—' }}</small
          ></button
        ><span class="status-pill" :class="entity.status.toLowerCase()">{{
          entity.status
        }}</span>
      </div>
      <p v-if="loading" class="muted empty">Loading entities…</p>
      <p v-else-if="!entities.length" class="muted empty">
        No entities match these filters.
      </p>
    </div>
    <PageNavigation
      class="pagination"
      :page="page"
      :next-page="page * pageSize < total ? page + 1 : null"
      :total="total"
      count-label="entities"
      :busy="loading"
      label="Geodata entities"
      @change="setPage"
    />
  </article>
  <article v-if="!isManagement || creating" class="panel map-panel">
    <div class="panel-heading">
      <div>
        <h2>Map</h2>
        <small class="muted"
          >Selecting an entity centres the map and opens its details. Point
          entities are clustered at wider zoom levels.</small
        >
      </div>
    </div>
    <LeafletMap
      :entities="entities"
      :selected-id="selected?.id"
      :drawing="drawing"
      :drawing-mode="drawingMode"
      height="680px"
      @select="selectEntity"
      @draw-created="onDrawCreated"
    />
  </article>
  <details v-else class="panel map-panel catalogue-map">
    <summary>
      Browse the catalogue on a map
      <small class="muted">Optional · click an entity to open its editor</small>
    </summary>
    <LeafletMap
      :entities="entities"
      :selected-id="selected?.id"
      height="520px"
      @select="selectEntity"
    />
  </details>
  <component
    :is="isManagement ? WorkspaceDialog : 'article'"
    v-if="selected"
    :open="editorOpen"
    :title="selected.name"
    eyebrow="ENTITY MANAGEMENT"
    :class="!isManagement ? 'panel editor-panel' : undefined"
    @request-close="closeEditor"
  >
    <template v-if="isManagement">
      <div class="editor-context">
        <span class="status-pill" :class="selected.status.toLowerCase()">{{
          selected.status
        }}</span>
        <small class="muted">{{ selected.id }}</small>
        <div class="toolbar">
          <button
            class="secondary"
            :disabled="editorSaving || selectedIndex <= 0"
            @click="navigateEntity(-1)"
          >
            Previous entity
          </button>
          <button
            class="secondary"
            :disabled="
              editorSaving ||
              selectedIndex < 0 ||
              selectedIndex >= entities.length - 1
            "
            @click="navigateEntity(1)"
          >
            Next entity
          </button>
        </div>
      </div>
      <nav class="editor-tabs" aria-label="Entity editing sections">
        <button
          v-for="tab in editorTabs"
          :key="tab.id"
          type="button"
          class="secondary"
          :aria-current="editorTab === tab.id ? 'page' : undefined"
          @click="setEditorTab(tab.id)"
        >
          {{ tab.label }}
        </button>
      </nav>
      <p v-if="dirtySections.length" class="editor-dirty" role="status">
        Unsaved: {{ dirtySections.join(', ') }}. Save the entity details section
        before closing.
      </p>
      <div v-if="message" class="notice" role="status">{{ message }}</div>
      <div v-if="error" class="error-card" role="alert">
        {{ error }}
        <button
          v-if="entityConflict"
          class="secondary"
          :disabled="editorSaving"
          @click="reloadConflictedEntity"
        >
          Reload selected entity
        </button>
      </div>
    </template>
    <div v-else class="panel-heading">
      <div>
        <p class="eyebrow">
          {{ isManagement ? 'ENTITY MANAGEMENT' : 'REVIEW DECISION' }}
        </p>
        <h2>{{ selected.name }}</h2>
        <small class="muted">{{ selected.id }}</small>
      </div>
      <span class="status-pill" :class="selected.status.toLowerCase()">{{
        selected.status
      }}</span>
    </div>
    <section
      v-if="!isManagement"
      class="entity-public-metadata"
      aria-label="Website and description"
    >
      <p>
        <strong>Website:</strong>
        <a
          v-if="safeWebsite(selected.website)"
          :href="safeWebsite(selected.website)!"
          target="_blank"
          rel="noopener noreferrer"
          >{{ selected.website }}</a
        ><span v-else>{{ selected.website || 'Not provided' }}</span>
      </p>
      <p>
        <strong>Description:</strong>
        {{ selected.description || 'Not provided' }}
      </p>
    </section>
    <section
      v-show="!isManagement || editorTab === 'source'"
      class="form-section source-comparison"
    >
      <div class="section-heading">
        <div>
          <h3>Source comparison</h3>
          <p class="field-help">
            The imported source snapshot remains immutable. Compare it with the
            current platform geometry before editing or recording a review
            decision.
          </p>
        </div>
      </div>
      <div class="compare-grid">
        <div>
          <small class="muted">Source snapshot</small>
          <pre class="data-preview">{{ sourceSnapshot(selected) }}</pre>
        </div>
        <div>
          <small class="muted">Current platform geometry</small>
          <pre class="data-preview">{{
            JSON.stringify(selected.geometry || {}, null, 2)
          }}</pre>
        </div>
      </div>
    </section>
    <fieldset :disabled="editorSaving" class="editor-fields">
      <p v-if="isManagement && !canEdit" class="read-only-note">
        Name, website, description, category and geometry edits require geodata
        review permission. Other actions depend on their own permissions.
      </p>
      <div
        class="editor-grid"
        :class="{ 'management-details-grid': isManagement }"
      >
        <section
          v-if="isManagement"
          v-show="editorTab === 'details'"
          class="form-section entity-details-section"
        >
          <h3>Entity name</h3>
          <p class="field-help">
            Name changes are audited and do not alter the original source.
          </p>
          <label
            >Display name<input v-model="editName" :readonly="!canEdit"
          /></label>
          <label
            >Name change note<textarea
              v-model="editNote"
              placeholder="Explain this name change"
            ></textarea>
          </label>
          <h3>Entity categories</h3>
          <p class="field-help">
            Categories are shared master data. Select one or more categories;
            changes are audited.
          </p>
          <div class="checkbox-grid">
            <label v-for="category in categories" :key="category.code"
              ><input
                v-model="editTypes"
                :disabled="!canEdit"
                type="checkbox"
                :value="category.code"
              />{{ category.label || category.code }}</label
            >
          </div>
          <h3>Website and description</h3>
          <p class="field-help">
            Public entity details. Website must use HTTP or HTTPS; descriptions
            are plain text.
          </p>
          <label
            >Website<input
              v-model="editWebsite"
              :readonly="!canEdit"
              type="url"
              maxlength="2048"
              placeholder="https://example.org"
          /></label>
          <label
            >Description<textarea
              v-model="editDescription"
              :readonly="!canEdit"
              maxlength="2000"
              placeholder="Plain text"
            ></textarea>
          </label>
          <button
            class="primary"
            :disabled="
              !canEdit || !editName.trim() || dirtySections.length === 0
            "
            @click="saveEntityDetails"
          >
            Save details
          </button>
        </section>
        <section
          v-show="!isManagement || editorTab === 'geometry'"
          class="form-section gis-admin-section"
          :class="{ wide: isManagement }"
        >
          <h3>
            {{
              isManagement
                ? 'GIS administration & geometry editor'
                : 'Review decision'
            }}
          </h3>
          <p v-if="isManagement" class="field-help">
            The map is read-only until you enable vertex editing or draw a
            replacement. Changes stay in this draft until Save geometry; closing
            without saving preserves the stored geometry.
          </p>
          <template v-if="isManagement">
            <LeafletMap
              v-if="editorTab === 'geometry'"
              :entities="geometryMapEntities"
              :selected-id="selected.id"
              :editable-id="editingId"
              :drawing="geometryDrawing"
              :drawing-mode="drawingMode"
              :show-clusters="false"
              height="min(42vh, 440px)"
              @geometry-change="onGeometryChange"
              @draw-created="onGeometryDrawCreated"
            />
            <div class="toolbar geometry-tools">
              <button
                class="secondary"
                :disabled="!canEdit || selected.status === 'RETIRED'"
                @click="startGeometryEdit"
              >
                Edit geometry vertices
              </button>
              <button
                v-if="editingId || geometryDrawing"
                class="secondary"
                @click="stopGeometryEdit"
              >
                Stop editing / drawing
              </button>
              <button
                class="secondary"
                :disabled="selected.status === 'RETIRED'"
                @click="drawReplacement('POINT')"
              >
                Replace with point
              </button>
              <button
                class="secondary"
                :disabled="selected.status === 'RETIRED'"
                @click="drawReplacement('WAY')"
              >
                Draw replacement trail
              </button>
              <button
                class="secondary"
                :disabled="selected.status === 'RETIRED'"
                @click="drawReplacement('POLYGON')"
              >
                Draw replacement polygon
              </button>
            </div>
            <p v-if="selected.status === 'RETIRED'" class="notice">
              Retired entity geometry is read-only.
            </p>
            <details class="geometry-json">
              <summary>Advanced GeoJSON / geometry type</summary>
              <label
                >Geometry type<select
                  v-model="geometryType"
                  :disabled="!canConvertGeometry"
                >
                  <option>Point</option>
                  <option>LineString</option>
                  <option>MultiLineString</option>
                  <option>Polygon</option>
                  <option>MultiPolygon</option>
                </select></label
              >
              <textarea
                v-model="geometryJson"
                :readonly="!canEdit || selected.status === 'RETIRED'"
                class="code-editor"
                placeholder="GeoJSON geometry"
              ></textarea>
              <p class="field-help">
                Coordinates must match the chosen type. The API validates the
                geometry before storing it.
              </p>
            </details>
            <label
              >Geometry change note<textarea
                v-model="geometryNote"
                placeholder="Explain why the geometry was adjusted"
              ></textarea>
            </label>
            <button
              class="primary"
              :disabled="selected.status === 'RETIRED'"
              @click="saveGeometry"
            >
              Save geometry
            </button>
          </template>
          <template v-else>
            <label
              >Status<select v-model="reviewStatus">
                <option
                  v-for="status in selectedStatusOptions"
                  :key="status"
                  :value="status"
                >
                  {{ status }}
                </option>
              </select></label
            >
            <textarea
              v-model="editNote"
              placeholder="Review note / decision evidence"
            ></textarea>
            <button class="primary" @click="saveStatus(reviewStatus)">
              Save review decision
            </button>
          </template>
        </section>
      </div>
      <section
        v-show="!isManagement || editorTab === 'location'"
        class="form-section"
      >
        <div class="section-heading">
          <div>
            <h3>Location metadata</h3>
            <p class="field-help">
              Reverse-geocoded values are automatic unless a field is explicitly
              marked as a manual override. Provider codes are read-only.
            </p>
          </div>
          <div class="toolbar">
            <button
              v-if="
                isManagement &&
                canEditLocation &&
                missingLocationFields(selected).length
              "
              class="secondary"
              :disabled="
                locationEnrichmentSubmitting ||
                selected.locationEnrichmentStatus === 'QUEUED'
              "
              @click="requestLocationEnrichment"
            >
              {{
                locationEnrichmentSubmitting ||
                selected.locationEnrichmentStatus === 'QUEUED'
                  ? 'Location update queued'
                  : selected.locationEnrichmentStatus === 'FAILED'
                    ? 'Retry location update'
                    : 'Update missing location data'
              }}
            </button>
            <button
              v-if="isManagement && canEditLocation"
              class="secondary"
              @click="startLocationEdit"
            >
              {{
                editingLocation
                  ? 'Reload provider options'
                  : 'Edit location metadata'
              }}
            </button>
          </div>
        </div>
        <p
          v-if="isManagement && missingLocationFields(selected).length"
          class="field-help"
          role="status"
        >
          Missing: {{ missingLocationFields(selected).join(', ') }}.
          <template v-if="selected.locationEnrichmentStatus === 'QUEUED'"
            >The update is waiting for the geodata worker.</template
          >
          <template v-else
            >Request a provider lookup for the current entity geometry; manually
            managed values are preserved.</template
          >
        </p>
        <p
          v-else-if="
            isManagement && selected.locationEnrichmentStatus === 'FAILED'
          "
          class="field-help"
          role="status"
        >
          The last location lookup failed. Existing metadata was kept; retry
          when ready.
        </p>
        <div v-if="!editingLocation" class="info-grid">
          <div>
            <span>Continent</span
            ><strong>{{ locationValue(selected, 'continent') || '—' }}</strong>
          </div>
          <div>
            <span>Country</span
            ><strong>{{ locationValue(selected, 'country') || '—' }}</strong>
          </div>
          <div>
            <span>Region</span
            ><strong>{{ locationValue(selected, 'region') || '—' }}</strong>
          </div>
          <div>
            <span>Province</span
            ><strong>{{ locationValue(selected, 'province') || '—' }}</strong>
          </div>
          <div>
            <span>County</span
            ><strong>{{ locationValue(selected, 'county') || '—' }}</strong>
          </div>
          <div>
            <span>City / municipality</span
            ><strong>{{
              locationValue(selected, 'city') ||
              locationValue(selected, 'municipality') ||
              '—'
            }}</strong>
          </div>
          <div>
            <span>Maidenhead grid squares (4)</span
            ><strong>{{
              selected.maidenheadGridSquares4?.join(', ') || '—'
            }}</strong>
          </div>
          <div>
            <span>Maidenhead locators (6)</span
            ><strong>{{
              selected.maidenheadLocators6?.join(', ') || '—'
            }}</strong>
          </div>
        </div>
        <div v-else class="form-grid location-editor-grid">
          <label
            v-for="field in ['continent', 'country', 'region', 'province']"
            :key="field"
            >{{
              field === 'region'
                ? 'Region / first subdivision'
                : field[0].toUpperCase() + field.slice(1)
            }}<input
              v-model="locationForm[field]"
              :list="`location-options-${field}`"
              @change="refreshLocationCodes(field)"
            /><datalist :id="`location-options-${field}`">
              <option
                v-for="item in locationValues(field)"
                :key="item.code || item.name"
                :value="item.name"
              >
                {{ item.code }}
              </option></datalist
            ><small class="field-help"
              >Provider-derived name; choose a valid value.</small
            ></label
          >
          <label
            >Continent code<input v-model="locationForm.continentCode" readonly
          /></label>
          <label
            >Country code<input v-model="locationForm.countryCode" readonly
          /></label>
          <label
            >Subdivision code<input
              v-model="locationForm.subdivisionCode"
              readonly
          /></label>
          <label
            >Province code<input v-model="locationForm.provinceCode" readonly
          /></label>
          <label
            >County / equivalent<input v-model="locationForm.county"
          /></label>
          <label>City<input v-model="locationForm.city" /></label>
          <label
            >Municipality<input v-model="locationForm.municipality"
          /></label>
          <label>Locality<input v-model="locationForm.locality" /></label>
          <fieldset class="wide">
            <legend>Manual overrides</legend>
            <div class="checkbox-grid">
              <label
                v-for="field in [
                  'continent',
                  'country',
                  'region',
                  'province',
                  'county',
                  'city',
                  'municipality',
                  'locality',
                ]"
                :key="field"
                ><input
                  v-model="locationManual"
                  type="checkbox"
                  :value="field"
                />Keep {{ field }} manual</label
              >
            </div>
          </fieldset>
          <div class="form-actions wide">
            <button class="primary" @click="saveLocation">Save location</button
            ><button class="secondary" @click="editingLocation = false">
              Cancel
            </button>
          </div>
        </div>
      </section>
      <section
        v-if="isManagement"
        v-show="editorTab === 'audit'"
        class="form-section"
      >
        <h3>Audit history</h3>
        <div class="audit-list">
          <div
            v-for="(item, index) in auditEntries()"
            :key="`${item.action || 'event'}-${item.occurredAt || item.editedAt || index}`"
            class="audit-row"
          >
            <strong>{{ item.action || 'AUDIT_EVENT' }}</strong
            ><span>{{
              item.occurredAt || item.editedAt || 'Time unavailable'
            }}</span
            ><small>{{
              item.note || item.reviewerId || item.editorId || ''
            }}</small>
          </div>
          <p v-if="!auditEntries().length" class="muted">
            No audit entries available.
          </p>
        </div>
        <button
          v-if="isGlobalAdmin"
          class="danger"
          @click="deleteEntity(selected.id)"
        >
          Permanently delete entity
        </button>
      </section>
      <section v-else class="form-section">
        <h3>Review audit context</h3>
        <div class="audit-list">
          <div
            v-for="(item, index) in auditEntries()"
            :key="`${item.action || 'event'}-${item.occurredAt || item.editedAt || index}`"
            class="audit-row"
          >
            <strong>{{ item.action || 'AUDIT_EVENT' }}</strong
            ><span>{{
              item.occurredAt || item.editedAt || 'Time unavailable'
            }}</span
            ><small>{{
              item.note || item.reviewerId || item.editorId || ''
            }}</small>
          </div>
          <p v-if="!auditEntries().length" class="muted">
            No audit entries available.
          </p>
        </div>
      </section>
    </fieldset>
  </component>
  <WorkspaceDialog
    v-if="deletionModal"
    :open="true"
    compact
    eyebrow="PERMANENT DELETION"
    :title="
      deletionModal.kind === 'single'
        ? `Delete ${deletionModal.entity.name}?`
        : `Delete ${deletionModal.totalCount} entities?`
    "
    @request-close="cancelDelete"
  >
    <div v-if="error" class="error-card" role="alert">{{ error }}</div>
    <ul v-if="deletionModal.kind === 'bulk'" class="bulk-delete-list">
      <li v-for="item in deletionModal.items" :key="item.entity.id">
        <strong>{{ item.entity.name }}</strong>
        <small
          >{{
            item.job.status === 'PREPARING'
              ? 'Preparing deletion details…'
              : item.job.status === 'PREPARATION_FAILED'
                ? 'Could not prepare this entity'
                : item.job.status || 'Ready for confirmation'
          }}<template v-if="item.error || item.job.error">
            · {{ item.error || item.job.error }}</template
          ></small
        >
      </li>
    </ul>
    <p
      v-if="deletionModal.kind === 'bulk' && preparingBulkDelete"
      class="notice"
      role="status"
    >
      Preparing deletion details for
      {{ deletionModal.items.filter((item) => item.job.id).length }} of
      {{ deletionModal.totalCount }} entities. No deletion is queued until you
      confirm below.
    </p>
    <p
      v-if="
        deletionModal.kind === 'single' &&
        (deletionModal.job.status || deletionModal.job.error)
      "
      class="notice"
    >
      {{ deletionModal.job.status
      }}<template v-if="deletionModal.job.error">
        · {{ deletionModal.job.error }}</template
      >
    </p>
    <p
      v-if="deletionModal.kind === 'bulk' && deletionModal.completedCount"
      class="notice"
    >
      {{ deletionModal.completedCount }} of
      {{ deletionModal.totalCount }} entities have been deleted. Remaining jobs
      are shown below.
    </p>
    <div class="error-card deletion-warning">
      <strong>This action cannot be undone.</strong>
      <p>
        {{
          deletionModal.kind === 'single'
            ? 'The entity, its audit history, and all linked activity will be permanently removed.'
            : 'The selected entities, their audit histories, and all linked activity will be permanently removed.'
        }}
      </p>
      <p v-if="deletionModal.kind === 'bulk' && preparingBulkDelete">
        Calculating linked QSO and activation impact…
      </p>
      <p v-else>
        <strong>{{
          deletionModal.kind === 'single'
            ? deletionModal.job.impact?.qsoCount || 0
            : deletionModal.impact.qsoCount || 0
        }}</strong>
        valid QSO(s) will be deleted in cascade.
        <strong>{{
          deletionModal.kind === 'single'
            ? deletionModal.job.impact?.activationCount || 0
            : deletionModal.impact.activationCount || 0
        }}</strong>
        activation(s) may become invalid.
      </p>
      <p>
        Award progress will be recalculated, and previously qualified awards may
        become invalid.
      </p>
    </div>
    <div class="form-actions">
      <button class="secondary" type="button" @click="cancelDelete">
        Cancel
      </button>
      <button
        v-if="deletionModal.kind === 'bulk' && bulkPreparationFailed"
        class="secondary"
        type="button"
        :disabled="preparingBulkDelete"
        @click="retryBulkDeletionPreparation"
      >
        {{
          preparingBulkDelete
            ? 'Retrying preparation…'
            : 'Retry failed preparation'
        }}
      </button>
      <button
        class="danger"
        type="button"
        :disabled="
          deleting ||
          (deletionModal.kind === 'bulk' &&
            (preparingBulkDelete ||
              bulkPreparationFailed ||
              !deletionModal.items.length)) ||
          (deletionModal.kind === 'single' &&
            String(deletionModal.job.status).toUpperCase() === 'FAILED')
        "
        @click="confirmDelete"
      >
        {{
          deleting
            ? 'Processing deletion jobs…'
            : deletionModal.kind === 'single'
              ? isPendingDeletionStatus(deletionModal.job.status)
                ? 'Check deletion status'
                : String(deletionModal.job.status).toUpperCase() === 'FAILED'
                  ? 'Deletion failed'
                  : 'Permanently delete entity'
              : preparingBulkDelete
                ? 'Preparing deletion details…'
                : bulkPreparationFailed
                  ? 'Resolve preparation errors first'
                  : deletionModal.items.some((item) =>
                        isPendingDeletionStatus(item.job.status),
                      )
                    ? 'Check deletion status'
                    : `Permanently delete ${deletionModal.items.length} entities`
        }}
      </button>
    </div>
  </WorkspaceDialog>
</template>
