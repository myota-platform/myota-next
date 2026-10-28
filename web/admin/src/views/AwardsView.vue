<script setup lang="ts">
import ProgrammeScope from '../components/ProgrammeScope.vue';
import { hasAnyScope } from '../lib/adminAccess';
import PageHeader from '../components/PageHeader.vue';
import PageNavigation from '../components/PageNavigation.vue';
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { apiRequest } from '../lib/api';
import { myotaClient } from '../lib/myotaClient';
import { createPendingIdempotencyKeys } from '../lib/pendingIdempotencyKeys';
import { useAppStore } from '../stores/app';
import { bytesFromBase64, inspectArtwork } from '../lib/awardArtwork';
import { utcInput, utcInputValue } from '../lib/utc';
import {
  validateAwardConfiguration,
  type AwardValidationIssue,
} from '../../../../contracts/award-definition.js';

interface TemplateElement {
  kind: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Award {
  id?: string;
  programmeSlug?: string;
  code: string;
  name: string;
  description?: string;
  awardText?: string;
  category?: string;
  status?: string;
  version?: number;
  achievementMetric?: string;
  condition?: unknown;
  levels?: unknown;
  effectiveFrom?: string;
  signatureAssetId?: string;
  managerName?: string;
  backgroundAsset?: Record<string, unknown>;
  printSpec?: Record<string, unknown>;
  template?: { elements?: TemplateElement[] };
}
interface AwardPage<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  nextPage: number | null;
}
interface AwardRecalculationJob {
  id?: string;
  jobId?: string;
  awardId: string;
  status?: string;
  attempts?: number;
  lastError?: string | null;
  completedAt?: string | null;
}
interface AwardDeletionJob {
  id?: string;
  kind?: string;
  awardId: string;
  awardName?: string;
  status?: string;
  attempts?: number;
  lastError?: string | null;
  completedAt?: string | null;
}

const store = useAppStore();
const pendingAwardMutationKeys = createPendingIdempotencyKeys(
  'myota_admin_pending_award_mutations',
);
const awardRecalculationStorageKey = 'myota_admin_award_recalculation_job';
const awardDeletionStorageKey = 'myota_admin_award_deletion_job';
const canManage = computed(() => hasAnyScope(store.account, 'awards.admin'));
const canDeleteAwards = computed(() =>
  [
    store.account?.role,
    ...(store.account?.roles || []).map((role) => role.role),
  ].some((role) =>
    ['GLOBAL_ADMIN', 'GLOBAL_OPERATOR'].includes(
      String(role || '').toUpperCase(),
    ),
  ),
);
const loading = ref(false);
let loadGeneration = 0;
const programme = ref(
  store.currentProgramme || store.programmes[0]?.slug || '',
);
const items = ref<Award[]>([]);
const selected = ref<Award | null>(null);
const editingPublished = ref(false);
const assets = ref<any[]>([]);
const requests = ref<any[]>([]);
const issuances = ref<any[]>([]);
const pageSize = 50;
const definitionPage = ref(1);
const definitionTotal = ref(0);
const requestPage = ref(1);
const requestTotal = ref(0);
const issuancePage = ref(1);
const issuanceTotal = ref(0);
const issueManagerName = ref('');
const issueSignatureAssetId = ref('');
const renderQueueStatus = reactive<Record<string, string>>({});
const awardRecalculation = ref<AwardRecalculationJob | null>(null);
const awardRecalculationLoading = ref(false);
const awardRecalculationError = ref('');
let awardRecalculationTimer: ReturnType<typeof setTimeout> | undefined;
const awardDeletion = ref<AwardDeletionJob | null>(null);
const awardDeletionLoading = ref(false);
const awardDeletionError = ref('');
let awardDeletionTimer: ReturnType<typeof setTimeout> | undefined;
const message = ref('');
const templateElements = ref<TemplateElement[]>(defaultElements());
const validationIssues = ref<AwardValidationIssue[]>([]);
const error = ref('');
const uploading = ref(false);
const saving = ref(false);
const previewing = ref(false);
const backgroundImage = ref('');
const signatureImage = ref('');
const backgrounds = computed(() =>
  assets.value.filter((asset) => asset.kind === 'BACKGROUND'),
);
const signatures = computed(() =>
  assets.value.filter((asset) => asset.kind === 'SIGNATURE'),
);
const selectedBackground = computed(() =>
  backgrounds.value.find((asset) => asset.objectKey === form.backgroundKey),
);
const editable = computed(
  () =>
    canManage.value &&
    (!selected.value ||
      ['DRAFT', 'CHANGES_REQUESTED'].includes(
        selected.value.status || 'DRAFT',
      ) ||
      (editingPublished.value && selected.value.status === 'PUBLISHED')),
);
const assetFile = ref<File | null>(null);
const dragState = ref<{ index: number; x: number; y: number } | null>(null);
const form = reactive({
  code: '',
  name: '',
  description: '',
  awardText: '',
  category: 'HUNTER',
  achievementMetric: 'QSO_COUNT',
  effectiveFrom: '',
  condition:
    '{\n  "kind": "AND",\n  "conditions": [{ "kind": "QSO_COUNT", "operator": "GTE", "value": 10 }]\n}',
  levels: '[{ "id": "level-10", "name": "10 contacts", "threshold": 10 }]',
  backgroundKey: '',
  backgroundType: 'image/png',
  width: 2481,
  height: 3508,
  page: 'A4',
  orientation: 'PORTRAIT',
  dpi: 300,
  signatureAssetId: '',
  managerName: '',
});
const assetForm = reactive({
  kind: 'SIGNATURE',
  name: '',
  objectKey: '',
  mediaType: 'image/png',
  width: 1200,
  height: 400,
  sha256: '',
});
const pageSizesMm: Record<string, [number, number]> = {
  A4: [210, 297],
  LETTER: [215.9, 279.4],
};
const canvasAspectRatio = computed(() => {
  const [width, height] = pageSizesMm[form.page] || pageSizesMm.A4;
  return form.orientation === 'LANDSCAPE'
    ? `${height} / ${width}`
    : `${width} / ${height}`;
});
function requiredBackgroundDimensions() {
  const [pageWidth, pageHeight] = pageSizesMm[form.page] || pageSizesMm.A4;
  const widthMm = form.orientation === 'LANDSCAPE' ? pageHeight : pageWidth;
  const heightMm = form.orientation === 'LANDSCAPE' ? pageWidth : pageHeight;
  const dpi = Number(form.dpi) || 300;
  return {
    width: Math.ceil((widthMm / 25.4) * dpi),
    height: Math.ceil((heightMm / 25.4) * dpi),
  };
}
function updateBackgroundDimensions(): void {
  const dimensions = requiredBackgroundDimensions();
  form.width = dimensions.width;
  form.height = dimensions.height;
}
watch(
  [() => form.page, () => form.orientation, () => form.dpi],
  updateBackgroundDimensions,
);
watch(
  [() => form.page, () => form.orientation],
  () => {
    document.documentElement.style.setProperty(
      '--award-canvas-aspect',
      canvasAspectRatio.value,
    );
  },
  { immediate: true },
);
onUnmounted(() => {
  document.documentElement.style.removeProperty('--award-canvas-aspect');
  if (awardRecalculationTimer) clearTimeout(awardRecalculationTimer);
});

function persistAwardRecalculation(): void {
  try {
    if (awardRecalculation.value)
      sessionStorage.setItem(
        awardRecalculationStorageKey,
        JSON.stringify(awardRecalculation.value),
      );
    else sessionStorage.removeItem(awardRecalculationStorageKey);
  } catch {
    // Keep the current job visible for this page even if browser storage is disabled.
  }
}

function scheduleAwardRecalculationRefresh(): void {
  if (awardRecalculationTimer) clearTimeout(awardRecalculationTimer);
  if (!['QUEUED', 'RUNNING'].includes(awardRecalculation.value?.status || ''))
    return;
  awardRecalculationTimer = setTimeout(() => {
    void refreshAwardRecalculation();
  }, 2000);
}

function persistAwardDeletion(): void {
  try {
    if (awardDeletion.value)
      sessionStorage.setItem(
        awardDeletionStorageKey,
        JSON.stringify(awardDeletion.value),
      );
    else sessionStorage.removeItem(awardDeletionStorageKey);
  } catch {
    // The current deletion remains visible if session storage is unavailable.
  }
}

function scheduleAwardDeletionRefresh(): void {
  if (awardDeletionTimer) clearTimeout(awardDeletionTimer);
  if (!['QUEUED', 'RUNNING'].includes(awardDeletion.value?.status || ''))
    return;
  awardDeletionTimer = setTimeout(() => {
    void refreshAwardDeletion();
  }, 2000);
}

async function refreshAwardDeletion(): Promise<void> {
  const current = awardDeletion.value;
  const id = current?.id;
  if (!current || !id || awardDeletionLoading.value) return;
  awardDeletionLoading.value = true;
  awardDeletionError.value = '';
  const awardName = selected.value?.name;
  try {
    awardDeletion.value = await apiRequest<AwardDeletionJob>(
      `/v1/awards/deletion-jobs/${encodeURIComponent(id)}`,
    );
    awardDeletion.value.awardId = current.awardId;
    awardDeletion.value.awardName = current.awardName;
    persistAwardDeletion();
    if (awardDeletion.value.status === 'SUCCEEDED') {
      if (selected.value?.id === current.awardId) selected.value = null;
      await load();
      message.value = `Award ${current.awardName || awardName || 'definition'} was permanently deleted.`;
    }
  } catch (cause) {
    awardDeletionError.value =
      cause instanceof Error
        ? cause.message
        : 'Unable to refresh award deletion status.';
  } finally {
    awardDeletionLoading.value = false;
    scheduleAwardDeletionRefresh();
  }
}

async function deleteAward(): Promise<void> {
  const award = selected.value;
  if (
    !canDeleteAwards.value ||
    !award?.id ||
    awardDeletionLoading.value ||
    !window.confirm(
      `Permanently delete “${award.name}” (${award.programmeSlug}, ${award.code}) and every version, request, issued record, progress row, and generated certificate file? This cannot be undone. Registered backgrounds and signatures remain in the shared asset library.`,
    )
  )
    return;
  awardDeletionLoading.value = true;
  awardDeletionError.value = '';
  try {
    const fingerprint = `award-delete:${award.id}`;
    const key = await pendingAwardMutationKeys.getOrCreate(fingerprint);
    const job = await apiRequest<AwardDeletionJob>(
      `/v1/awards/${encodeURIComponent(award.id)}/deletion-jobs`,
      { method: 'POST', headers: { 'Idempotency-Key': key } },
    );
    job.awardId = award.id;
    job.awardName = award.name;
    items.value = items.value.map((item) =>
      item.programmeSlug === award.programmeSlug && item.code === award.code
        ? { ...item, status: 'DELETING' }
        : item,
    );
    if (selected.value?.id && selected.value.code === award.code)
      selected.value = { ...selected.value, status: 'DELETING' };
    awardDeletion.value = job;
    await pendingAwardMutationKeys.complete(fingerprint);
    persistAwardDeletion();
    message.value = `Deleting ${award.name} and its award-owned records and assets.`;
  } catch (cause) {
    awardDeletionError.value =
      cause instanceof Error ? cause.message : 'Unable to delete this award.';
  } finally {
    awardDeletionLoading.value = false;
    scheduleAwardDeletionRefresh();
  }
}

async function refreshAwardRecalculation(): Promise<void> {
  const current = awardRecalculation.value;
  const id = current?.jobId || current?.id;
  if (!current || !id || awardRecalculationLoading.value) return;
  awardRecalculationLoading.value = true;
  awardRecalculationError.value = '';
  try {
    awardRecalculation.value = await apiRequest<AwardRecalculationJob>(
      `/v1/awards/${encodeURIComponent(current.awardId)}/recalculation-jobs/${encodeURIComponent(id)}`,
    );
    awardRecalculation.value.awardId = current.awardId;
    persistAwardRecalculation();
    if (awardRecalculation.value.status === 'SUCCEEDED') await load();
  } catch (cause) {
    awardRecalculationError.value =
      cause instanceof Error
        ? cause.message
        : 'Unable to refresh award recalculation status.';
  } finally {
    awardRecalculationLoading.value = false;
    scheduleAwardRecalculationRefresh();
  }
}

async function recalculateAllProgress(): Promise<void> {
  const award = selected.value;
  if (
    !canManage.value ||
    !award?.id ||
    award.status !== 'PUBLISHED' ||
    awardRecalculationLoading.value ||
    !window.confirm(
      `Recalculate progress for all participants using ${award.name}? This runs in the background.`,
    )
  )
    return;
  awardRecalculationLoading.value = true;
  awardRecalculationError.value = '';
  const fingerprint = `award-recalculate:${award.id}:${award.version ?? 1}:all`;
  try {
    const key = await pendingAwardMutationKeys.getOrCreate(fingerprint);
    awardRecalculation.value = await apiRequest<AwardRecalculationJob>(
      `/v1/awards/${encodeURIComponent(award.id)}/recalculation-jobs`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: JSON.stringify({ subjectIds: [] }),
      },
    );
    awardRecalculation.value.awardId = award.id;
    await pendingAwardMutationKeys.complete(fingerprint);
    persistAwardRecalculation();
  } catch (cause) {
    awardRecalculationError.value =
      cause instanceof Error
        ? cause.message
        : 'Unable to queue award recalculation.';
  } finally {
    awardRecalculationLoading.value = false;
    scheduleAwardRecalculationRefresh();
  }
}

function defaultElements(): TemplateElement[] {
  return [
    {
      kind: 'AWARD_NAME',
      label: 'Award name',
      x: 0.25,
      y: 0.1,
      width: 0.5,
      height: 0.08,
    },
    {
      kind: 'AWARD_TEXT',
      label: 'Award text',
      x: 0.2,
      y: 0.21,
      width: 0.6,
      height: 0.07,
    },
    {
      kind: 'CALLSIGN',
      label: 'Callsign',
      x: 0.35,
      y: 0.34,
      width: 0.3,
      height: 0.08,
    },
    {
      kind: 'PERSON_NAME',
      label: 'Participant name',
      x: 0.25,
      y: 0.45,
      width: 0.5,
      height: 0.08,
    },
    {
      kind: 'DATE_OBTAINED',
      label: 'Date obtained',
      x: 0.35,
      y: 0.57,
      width: 0.3,
      height: 0.06,
    },
    {
      kind: 'MANAGER_NAME',
      label: 'Award manager',
      x: 0.2,
      y: 0.79,
      width: 0.35,
      height: 0.06,
    },
    {
      kind: 'MANAGER_SIGNATURE',
      label: 'Manager signature',
      x: 0.6,
      y: 0.73,
      width: 0.25,
      height: 0.14,
    },
  ];
}
function edit(item: Award | null, createPublishedVersion = false): void {
  selected.value = item;
  validationIssues.value = [];
  error.value = '';
  editingPublished.value = createPublishedVersion;
  const background: any = item?.backgroundAsset || {};
  const print: any = item?.printSpec || {};
  templateElements.value = JSON.parse(
    JSON.stringify(
      item?.template?.elements?.length
        ? item.template.elements
        : defaultElements(),
    ),
  );
  const defaults = defaultElements();
  for (const element of templateElements.value)
    element.label ||=
      defaults.find((item) => item.kind === element.kind)?.label ||
      element.kind;
  templateElements.value.push(
    ...defaults.filter(
      (item) =>
        !templateElements.value.some((element) => element.kind === item.kind),
    ),
  );
  Object.assign(form, {
    code: item?.code || '',
    name: item?.name || '',
    description: item?.description || '',
    awardText: item?.awardText || '',
    category: item?.category || 'HUNTER',
    achievementMetric: item?.achievementMetric || 'QSO_COUNT',
    effectiveFrom: utcInput(item?.effectiveFrom),
    condition: JSON.stringify(
      item?.condition || {
        kind: 'AND',
        conditions: [{ kind: 'QSO_COUNT', operator: 'GTE', value: 10 }],
      },
      null,
      2,
    ),
    levels: JSON.stringify(
      item?.levels || [{ id: 'level-10', name: '10 contacts', threshold: 10 }],
      null,
      2,
    ),
    backgroundKey: background.objectKey || '',
    backgroundType: background.mediaType || 'image/png',
    width: background.widthPx || 2481,
    height: background.heightPx || 3508,
    page: print.page || 'A4',
    orientation: print.orientation || 'PORTRAIT',
    dpi: print.dpi || 300,
    signatureAssetId: item?.signatureAssetId || '',
    managerName: item?.managerName || '',
  });
  updateBackgroundDimensions();
}
function beginPublishedVersionEdit(): void {
  if (!canManage.value || selected.value?.status !== 'PUBLISHED') return;
  edit(selected.value, true);
}
function restoreDefaults(): void {
  if (
    window.confirm(
      'Restore the default certificate fields? Save the draft to persist this layout.',
    )
  )
    templateElements.value = defaultElements();
}
function addTemplateElement(): void {
  templateElements.value.push({
    kind: 'CUSTOM_TEXT',
    label: 'Custom text',
    x: 0.3,
    y: 0.2,
    width: 0.4,
    height: 0.06,
  });
}
function removeTemplateElement(index: number): void {
  if (templateElements.value[index]?.kind === 'CUSTOM_TEXT')
    templateElements.value.splice(index, 1);
}
function elementText(element: TemplateElement): string {
  const values: Record<string, string> = {
    AWARD_NAME: form.name || 'Award name',
    AWARD_TEXT: form.awardText || 'Award text',
    CALLSIGN: 'EA7TEST',
    PERSON_NAME: 'Demo Radio Operator',
    DATE_OBTAINED: new Date().toISOString().slice(0, 10),
    MANAGER_NAME: form.managerName || 'Demo Award Manager',
    MANAGER_SIGNATURE: 'Signature preview',
  };
  return values[element.kind] || element.label;
}
function chooseBackground(): void {
  const asset = selectedBackground.value;
  if (asset)
    Object.assign(form, {
      backgroundType: asset.mediaType,
    });
  updateBackgroundDimensions();
}
async function selectAward(item: Award): Promise<void> {
  try {
    edit(await apiRequest<Award>(`/v1/awards/${encodeURIComponent(item.id!)}`));
  } catch (cause) {
    error.value = String(cause);
  }
}
async function loadAssets(): Promise<{ items: any[] }> {
  const items: any[] = [];
  let page: number | null = 1;
  while (page) {
    const data: { items: any[]; nextPage?: number } = await apiRequest(
      `/v1/awards/assets?page=${page}&pageSize=100`,
    );
    items.push(...(data.items || []));
    page = data.nextPage || null;
  }
  return { items };
}
const imageCache = new Map<string, string>();
async function imageSource(id?: string): Promise<string> {
  if (!id) return '';
  if (imageCache.has(id)) return imageCache.get(id)!;
  const result = await myotaClient.getAwardAssetContent<{
    mediaType: string;
    contentBase64: string;
  }>(id);
  const source = `data:${result.mediaType};base64,${result.contentBase64}`;
  imageCache.set(id, source);
  return source;
}
watch(
  () => selectedBackground.value?.id,
  async (id) => {
    backgroundImage.value = '';
    try {
      const source = await imageSource(id);
      if (selectedBackground.value?.id === id) backgroundImage.value = source;
    } catch (cause) {
      error.value = String(cause);
    }
  },
);
watch(
  () => form.signatureAssetId,
  async (id) => {
    signatureImage.value = '';
    try {
      const source = await imageSource(id);
      if (form.signatureAssetId === id) signatureImage.value = source;
    } catch (cause) {
      error.value = String(cause);
    }
  },
);
async function previewPdf(): Promise<void> {
  if (!canManage.value || previewing.value) return;
  const popup = window.open('about:blank', '_blank');
  if (!popup) {
    error.value = 'Allow pop-ups for MyOTA to open the PDF preview.';
    return;
  }
  popup.opener = null;
  popup.document.body.textContent = 'Generating preview…';
  previewing.value = true;
  error.value = '';
  try {
    const result = await myotaClient.createAwardPreview<{
      contentBase64: string;
    }>({
      name: form.name || 'Award preview',
      awardText: form.awardText,
      ...(form.backgroundKey
        ? {
            backgroundAsset: selectedBackground.value || {
              kind: 'BACKGROUND',
              name: 'Existing background',
              objectKey: form.backgroundKey,
              mediaType: form.backgroundType,
              widthPx: form.width,
              heightPx: form.height,
            },
          }
        : {}),
      printSpec: {
        page: form.page,
        orientation: form.orientation,
        dpi: Number(form.dpi),
      },
      template: { elements: templateElements.value },
      signatureAssetId: form.signatureAssetId || undefined,
      managerName: form.managerName,
    });
    const url = URL.createObjectURL(
      new Blob([bytesFromBase64(result.contentBase64)], {
        type: 'application/pdf',
      }),
    );
    popup.location.replace(url);
    window.setTimeout(() => URL.revokeObjectURL(url), 300_000);
    message.value =
      'Mock PDF opened in a separate window. No award was issued or saved.';
  } catch (cause) {
    popup.close();
    error.value = String(cause);
  } finally {
    previewing.value = false;
  }
}
function beginDrag(event: PointerEvent, index: number): void {
  if (!editable.value || saving.value) return;
  event.preventDefault();
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  dragState.value = { index, x: event.clientX, y: event.clientY };
}
function moveDrag(event: PointerEvent): void {
  if (!dragState.value) return;
  const canvas = event.currentTarget as HTMLElement;
  const rect = canvas.getBoundingClientRect();
  const element = templateElements.value[dragState.value.index];
  if (!element) return;
  const deltaX = (event.clientX - dragState.value.x) / rect.width;
  const deltaY = (event.clientY - dragState.value.y) / rect.height;
  element.x = Math.max(0, Math.min(1 - element.width, element.x + deltaX));
  element.y = Math.max(0, Math.min(1 - element.height, element.y + deltaY));
  dragState.value.x = event.clientX;
  dragState.value.y = event.clientY;
}
function endDrag(): void {
  dragState.value = null;
}
async function load(selectedId?: string | Event): Promise<void> {
  const id = typeof selectedId === 'string' ? selectedId : undefined;
  const generation = ++loadGeneration;
  loading.value = true;
  error.value = '';
  try {
    const [awardData, assetData, requestData, issuanceData] = await Promise.all(
      [
        programme.value
          ? apiRequest<AwardPage<Award>>(
              `/v1/awards?programme=${encodeURIComponent(programme.value)}&page=${definitionPage.value}&pageSize=${pageSize}`,
            )
          : Promise.resolve({
              items: [],
              page: definitionPage.value,
              pageSize,
              total: 0,
              nextPage: null,
            }),
        loadAssets(),
        apiRequest<AwardPage<any>>(
          `/v1/awards/requests?page=${requestPage.value}&pageSize=${pageSize}`,
        ),
        apiRequest<AwardPage<any>>(
          `/v1/awards/issuances?page=${issuancePage.value}&pageSize=${pageSize}`,
        ),
      ],
    );
    if (generation !== loadGeneration) return;
    items.value = awardData.items || [];
    definitionPage.value = awardData.page;
    definitionTotal.value = awardData.total;
    assets.value = assetData.items || [];
    requests.value = requestData.items || [];
    requestPage.value = requestData.page;
    requestTotal.value = requestData.total;
    issuances.value = issuanceData.items || [];
    issuancePage.value = issuanceData.page;
    issuanceTotal.value = issuanceData.total;
    if (id)
      edit(await apiRequest<Award>(`/v1/awards/${encodeURIComponent(id)}`));
  } catch (cause) {
    if (generation === loadGeneration) error.value = String(cause);
  } finally {
    if (generation === loadGeneration) loading.value = false;
  }
}
function setDefinitionPage(page: number): void {
  if (
    page < 1 ||
    (page - 1) * pageSize >= definitionTotal.value ||
    loading.value
  )
    return;
  definitionPage.value = page;
  void load();
}
function setRequestPage(page: number): void {
  if (page < 1 || (page - 1) * pageSize >= requestTotal.value || loading.value)
    return;
  requestPage.value = page;
  void load();
}
function setIssuancePage(page: number): void {
  if (page < 1 || (page - 1) * pageSize >= issuanceTotal.value || loading.value)
    return;
  issuancePage.value = page;
  void load();
}
async function issueAwardRequest(request: {
  id: string;
  status: string;
  callsign: string;
}): Promise<void> {
  if (
    !canManage.value ||
    saving.value ||
    request.status !== 'REQUESTED' ||
    !issueManagerName.value.trim() ||
    !issueSignatureAssetId.value
  )
    return;
  saving.value = true;
  error.value = '';
  message.value = '';
  const requestPath = `/v1/awards/requests/${encodeURIComponent(request.id)}/issuances`;
  const body = {
    managerName: issueManagerName.value.trim(),
    signatureAssetId: issueSignatureAssetId.value,
  };
  const fingerprint = JSON.stringify([
    store.account?.id,
    requestPath,
    'POST',
    body,
  ]);
  try {
    await apiRequest(requestPath, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'Idempotency-Key':
          await pendingAwardMutationKeys.getOrCreate(fingerprint),
      },
    });
    await pendingAwardMutationKeys.complete(fingerprint);
    message.value = `Award issued to ${request.callsign}.`;
    await load(selected.value?.id);
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : 'Award issuance failed.';
  } finally {
    saving.value = false;
  }
}
async function queueCertificateRender(issuance: {
  id: string;
  callsign: string;
  artifact?: { downloadReady?: boolean };
}): Promise<void> {
  if (
    !canManage.value ||
    saving.value ||
    issuance.artifact?.downloadReady ||
    renderQueueStatus[issuance.id] === 'QUEUED'
  )
    return;
  saving.value = true;
  error.value = '';
  message.value = '';
  const requestPath = `/v1/awards/issuances/${encodeURIComponent(issuance.id)}/render-jobs`;
  const body = {};
  const fingerprint = JSON.stringify([
    store.account?.id,
    requestPath,
    'POST',
    body,
  ]);
  try {
    await apiRequest(requestPath, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'Idempotency-Key':
          await pendingAwardMutationKeys.getOrCreate(fingerprint),
      },
    });
    await pendingAwardMutationKeys.complete(fingerprint);
    renderQueueStatus[issuance.id] = 'QUEUED';
    message.value = `Certificate PDF queued for ${issuance.callsign}.`;
  } catch (cause) {
    error.value =
      cause instanceof Error
        ? cause.message
        : 'Unable to queue certificate PDF.';
  } finally {
    saving.value = false;
  }
}
async function save(): Promise<void> {
  if (!editable.value || saving.value) return;
  error.value = '';
  message.value = '';
  validationIssues.value = [];
  let condition: unknown;
  let levels: unknown;
  try {
    condition = JSON.parse(form.condition);
  } catch {
    validationIssues.value = [
      { path: 'condition', message: 'must contain valid JSON' },
    ];
  }
  try {
    levels = JSON.parse(form.levels);
  } catch {
    validationIssues.value = [
      ...validationIssues.value,
      { path: 'levels', message: 'must contain valid JSON' },
    ];
  }
  if (validationIssues.value.length) return;
  const body = {
    awardId: selected.value?.id,
    programmeSlug: programme.value,
    code: form.code,
    name: form.name,
    description: form.description,
    awardText: form.awardText,
    category: form.category,
    achievementMetric: form.achievementMetric,
    condition,
    levels,
    backgroundAsset: {
      kind: 'BACKGROUND',
      name: selectedBackground.value?.name || `${form.name} background`,
      objectKey: form.backgroundKey,
      mediaType: form.backgroundType,
      widthPx: Number(form.width),
      heightPx: Number(form.height),
    },
    printSpec: {
      ...selected.value?.printSpec,
      page: form.page,
      orientation: form.orientation,
      dpi: Number(form.dpi),
    },
    template: {
      ...selected.value?.template,
      elements: templateElements.value,
    },
    signatureAssetId: form.signatureAssetId || null,
    managerName: form.managerName,
    effectiveFrom: utcInputValue(
      form.effectiveFrom,
      selected.value?.effectiveFrom,
    ),
    ...(editingPublished.value
      ? { expectedVersion: selected.value?.version ?? 1 }
      : {}),
  };
  validationIssues.value = validateAwardConfiguration(body);
  if (validationIssues.value.length) return;

  saving.value = true;
  try {
    let saved: Award;
    if (selected.value?.id) {
      const id = selected.value.id;
      const requestPath = `/v1/awards/${encodeURIComponent(id)}`;
      const fingerprint = JSON.stringify([
        store.account?.id,
        requestPath,
        'PATCH',
        body,
      ]);
      saved = await myotaClient.patchAward<Award>(
        id,
        body,
        await pendingAwardMutationKeys.getOrCreate(fingerprint),
      );
      await pendingAwardMutationKeys.complete(fingerprint);
    } else {
      const requestPath = '/v1/awards';
      const fingerprint = JSON.stringify([
        store.account?.id,
        requestPath,
        'POST',
        body,
      ]);
      saved = await apiRequest<Award>('/v1/awards', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: {
          'Idempotency-Key':
            await pendingAwardMutationKeys.getOrCreate(fingerprint),
        },
      });
      await pendingAwardMutationKeys.complete(fingerprint);
    }
    editingPublished.value = false;
    message.value =
      saved.status === 'DRAFT' && saved.version && saved.version > 1
        ? `Award version ${saved.version} saved as a draft.`
        : 'Award draft saved.';
    await load(saved.id);
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : 'Invalid award definition.';
  } finally {
    saving.value = false;
  }
}
const awardValidationTargets: Record<string, string> = {
  awardId: 'award-code',
  programmeSlug: 'award-name',
  code: 'award-code',
  name: 'award-name',
  description: 'award-description',
  awardText: 'award-text',
  category: 'award-category',
  achievementMetric: 'award-achievement-metric',
  condition: 'award-condition',
  levels: 'award-levels',
  backgroundAsset: 'award-background',
  printSpec: 'award-page',
  template: 'award-template-layout',
  signatureAssetId: 'award-signature',
  managerName: 'award-manager-name',
  effectiveFrom: 'award-effective-from',
  expectedVersion: 'award-name',
};
const awardValidationLabels: Record<string, string> = {
  awardId: 'Award',
  programmeSlug: 'Programme',
  code: 'Code',
  name: 'Name',
  description: 'Description',
  awardText: 'Award Text',
  category: 'Category',
  achievementMetric: 'Achievement metric',
  condition: 'Condition JSON',
  levels: 'Levels JSON',
  backgroundAsset: 'Background image',
  printSpec: 'Print profile',
  template: 'Certificate layout',
  signatureAssetId: 'Manager signature',
  managerName: 'Award manager name',
  effectiveFrom: 'Effective from',
  expectedVersion: 'Award version',
};
function awardValidationLabel(issue: AwardValidationIssue): string {
  const root = issue.path.split(/[.[\]]/, 1)[0] || '$';
  const remainder = issue.path
    .slice(root.length)
    .replace(/^\./, '')
    .replaceAll('[', '.')
    .replaceAll(']', '');
  const label = awardValidationLabels[root] || root;
  return `${label}${remainder ? ` (${remainder})` : ''}: ${issue.message}`;
}
function awardValidationTarget(issue: AwardValidationIssue): string {
  const root = issue.path.split(/[.[\]]/, 1)[0];
  if (issue.path.startsWith('printSpec.dpi')) return 'award-dpi';
  if (issue.path.startsWith('printSpec.orientation'))
    return 'award-orientation';
  return awardValidationTargets[root] || 'award-validation-heading';
}
function hasAwardFieldError(field: string): boolean {
  return validationIssues.value.some(
    (issue) =>
      issue.path === field ||
      issue.path.startsWith(`${field}.`) ||
      issue.path.startsWith(`${field}[`),
  );
}
async function action(
  actionName: 'submit' | 'review' | 'publish' | 'retire',
  decision?: string,
): Promise<void> {
  if (!selected.value?.id || !canManage.value || saving.value) return;
  saving.value = true;
  error.value = '';
  message.value = '';
  try {
    if (actionName === 'publish' && !form.effectiveFrom)
      throw new Error('Choose an effective date before publishing.');
    const body =
      actionName === 'review'
        ? { status: decision, reviewerId: store.account?.id }
        : actionName === 'publish'
          ? {
              status: 'PUBLISHED',
              effectiveFrom: utcInputValue(
                form.effectiveFrom,
                selected.value?.effectiveFrom,
              ),
              publisherId: store.account?.id,
            }
          : actionName === 'retire'
            ? { status: 'RETIRED', retiredBy: store.account?.id }
            : { status: 'UNDER_REVIEW', submitterId: store.account?.id };
    const id = selected.value.id;
    const requestPath = `/v1/awards/${encodeURIComponent(id)}`;
    const fingerprint = JSON.stringify([
      store.account?.id,
      requestPath,
      'PATCH',
      body,
    ]);
    await myotaClient.patchAward(
      id,
      body,
      await pendingAwardMutationKeys.getOrCreate(fingerprint),
    );
    await pendingAwardMutationKeys.complete(fingerprint);
    const actionMessages = {
      submit: 'submitted',
      review: 'reviewed',
      publish: 'published',
      retire: 'retired',
    };
    message.value = `Award ${actionMessages[actionName]}.`;
    await load(selected.value.id);
  } catch (cause) {
    message.value = '';
    error.value =
      cause instanceof Error ? cause.message : 'Award action failed.';
  } finally {
    saving.value = false;
  }
}
function selectAssetFile(event: Event): void {
  assetFile.value = (event.target as HTMLInputElement).files?.[0] || null;
  if (assetFile.value) {
    assetForm.name ||= assetFile.value.name;
    assetForm.mediaType = assetFile.value.type || assetForm.mediaType;
  }
}
async function registerAsset(): Promise<void> {
  if (!canManage.value || !assetFile.value || uploading.value) return;
  uploading.value = true;
  error.value = '';
  try {
    const file = assetFile.value;
    const dimensions = await inspectArtwork(file);
    Object.assign(assetForm, {
      width: dimensions.width,
      height: dimensions.height,
      mediaType: file.type,
      objectKey: `${assetForm.kind.toLowerCase()}/${crypto.randomUUID()}/${file.name.replace(/[^a-zA-Z0-9._-]/g, '-')}`,
    });
    const asset = await apiRequest<any>('/v1/awards/assets', {
      method: 'POST',
      body: JSON.stringify({
        kind: assetForm.kind,
        name: assetForm.name,
        objectKey: assetForm.objectKey,
        mediaType: assetForm.mediaType,
        widthPx: Number(assetForm.width),
        heightPx: Number(assetForm.height),
        sha256: assetForm.sha256 || undefined,
      }),
    });
    await myotaClient.putAwardAssetContent(asset.id, file);
    message.value =
      'Image uploaded to the asset library. Save the draft to keep its selection.';
    Object.assign(assetForm, { name: '', objectKey: '', sha256: '' });
    assetFile.value = null;
    await load();
    if (editable.value && asset.kind === 'BACKGROUND') {
      form.backgroundKey = asset.objectKey;
      chooseBackground();
    }
    if (editable.value && asset.kind === 'SIGNATURE')
      form.signatureAssetId = asset.id;
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : 'Unable to upload asset.';
  } finally {
    uploading.value = false;
  }
}
watch(programme, () => {
  store.currentProgramme = programme.value;
  definitionPage.value = 1;
  edit(null);
  load();
});
onMounted(() => {
  store.currentProgramme = programme.value;
  try {
    const saved = JSON.parse(
      sessionStorage.getItem(awardRecalculationStorageKey) || 'null',
    ) as AwardRecalculationJob | null;
    if (saved?.awardId && (saved.jobId || saved.id)) {
      awardRecalculation.value = saved;
      void refreshAwardRecalculation();
    }
  } catch {
    sessionStorage.removeItem(awardRecalculationStorageKey);
  }
  try {
    const saved = JSON.parse(
      sessionStorage.getItem(awardDeletionStorageKey) || 'null',
    ) as AwardDeletionJob | null;
    if (saved?.awardId && saved.id) {
      awardDeletion.value = saved;
      void refreshAwardDeletion();
    }
  } catch {
    sessionStorage.removeItem(awardDeletionStorageKey);
  }
  void load();
});
onUnmounted(() => {
  if (awardDeletionTimer) clearTimeout(awardDeletionTimer);
});
</script>

<template>
  <PageHeader :refresh="() => load()" :busy="saving || uploading || loading"
    ><a
      class="secondary"
      href="/award-configuration-reference.html"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Award JSON reference (opens in a new tab)"
      >Award JSON reference</a
    ><button
      v-if="canManage"
      class="primary"
      :disabled="saving || uploading || loading"
      @click="edit(null)"
    >
      New award draft
    </button></PageHeader
  >
  <ProgrammeScope
    v-model="programme"
    :disabled="loading || saving || uploading"
  />
  <div v-if="message" class="notice" role="status">{{ message }}</div>
  <div v-if="error" class="error-card" role="alert">{{ error }}</div>
  <section
    v-if="awardDeletion"
    class="activity-job"
    aria-live="polite"
    aria-label="Award deletion status"
  >
    <strong>{{ awardDeletion.awardName || 'Award' }} deletion</strong>
    <span class="status-chip">{{ awardDeletion.status || 'QUEUED' }}</span>
    <p v-if="['QUEUED', 'RUNNING'].includes(awardDeletion.status || '')">
      Award records and stored files are being removed. Cleanup failures are
      retried safely.
    </p>
    <p v-else-if="awardDeletion.status === 'FAILED'" class="error-text">
      Deletion stopped after {{ awardDeletion.attempts ?? 0 }} attempts. Select
      the award to retry after reviewing the service error.
    </p>
    <p v-else-if="awardDeletion.status === 'SUCCEEDED'">
      Deletion completed and was recorded in the audit log.
    </p>
    <p v-if="awardDeletion.lastError" class="error-text">
      {{ awardDeletion.lastError }}
    </p>
    <p v-if="awardDeletionError" class="error-text" role="alert">
      {{ awardDeletionError }}
    </p>
  </section>
  <section
    v-if="validationIssues.length"
    class="error-card"
    role="alert"
    aria-labelledby="award-validation-heading"
  >
    <strong id="award-validation-heading" tabindex="-1"
      >Check these award configuration fields before saving:</strong
    >
    <ul>
      <li
        v-for="(issue, index) in validationIssues"
        :key="`${issue.path}-${index}`"
      >
        <a :href="`#${awardValidationTarget(issue)}`">{{
          awardValidationLabel(issue)
        }}</a>
      </li>
    </ul>
  </section>
  <div class="split-layout">
    <article class="panel">
      <div class="panel-heading">
        <div>
          <h2>Award definitions</h2>
          <small class="muted">{{ definitionTotal }} awards</small>
        </div>
      </div>
      <div class="table-list">
        <button
          v-for="item in items"
          :key="item.id"
          class="table-row"
          :class="{ selected: selected?.id === item.id }"
          @click="selectAward(item)"
        >
          <span
            ><strong>{{ item.name }}</strong
            ><small
              >{{ item.code }} · v{{ item.version ?? 1 }} ·
              {{ item.category }} · {{ item.programmeSlug }}</small
            ></span
          ><span
            class="status-pill"
            :class="(item.status || '').toLowerCase()"
            >{{ item.status }}</span
          >
        </button>
        <p v-if="!items.length" class="muted empty">
          No awards configured for this programme.
        </p>
      </div>
      <PageNavigation
        :page="definitionPage"
        :next-page="
          definitionPage * pageSize < definitionTotal
            ? definitionPage + 1
            : null
        "
        :total="definitionTotal"
        count-label="awards"
        :busy="loading"
        label="award definitions"
        @change="setDefinitionPage"
      />
    </article>
    <article class="panel">
      <div class="panel-heading">
        <h2>
          {{
            editingPublished && selected
              ? `${selected.name} · Draft version ${Number(selected.version || 1) + 1}`
              : selected
                ? selected.name
                : 'New award draft'
          }}
        </h2>
        <button
          v-if="
            canManage && selected?.status === 'PUBLISHED' && !editingPublished
          "
          class="secondary"
          type="button"
          :disabled="saving"
          @click="beginPublishedVersionEdit"
        >
          Create a new version for this award
        </button>
        <button
          v-if="canDeleteAwards && selected?.id"
          class="danger"
          type="button"
          :disabled="awardDeletionLoading"
          @click="deleteAward"
        >
          {{
            selected.status === 'DELETING'
              ? 'Check or retry deletion'
              : 'Delete award permanently'
          }}
        </button>
        <span
          v-else-if="editingPublished && selected"
          class="status-chip"
          role="status"
        >
          Editing draft version {{ Number(selected.version || 1) + 1 }}
        </span>
      </div>
      <p
        v-if="editingPublished && selected"
        class="read-only-note"
        role="status"
      >
        This draft copies published version {{ Number(selected.version || 1) }}.
        Saving creates version {{ Number(selected.version || 1) + 1 }} as a
        separate draft; the published version and awards issued from it stay
        unchanged.
      </p>
      <p v-if="!editable" class="read-only-note">
        This award version is read-only. Create an editable version to preserve
        the published definition while you make and review changes.
      </p>
      <section
        v-if="canManage && selected?.id && selected.status === 'PUBLISHED'"
        class="award-recalculation"
        aria-labelledby="award-recalculation-title"
      >
        <div class="panel-heading">
          <div>
            <h3 id="award-recalculation-title">Participant progress</h3>
            <p class="muted">
              Recalculate progress for all participants in the background.
            </p>
          </div>
          <button
            class="secondary"
            :disabled="awardRecalculationLoading"
            @click="recalculateAllProgress"
          >
            {{
              awardRecalculationLoading
                ? 'Working…'
                : 'Recalculate all progress'
            }}
          </button>
        </div>
        <div
          v-if="awardRecalculation?.awardId === selected.id"
          class="activity-job"
        >
          <p
            class="award-recalculation-message"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <template
              v-if="(awardRecalculation.status || 'QUEUED') === 'QUEUED'"
            >
              Request accepted; recalculation is queued.
            </template>
            <template v-else-if="awardRecalculation.status === 'RUNNING'">
              Recalculation is in progress.
            </template>
            <template v-else-if="awardRecalculation.status === 'SUCCEEDED'">
              Recalculation completed.
            </template>
            <template v-else-if="awardRecalculation.status === 'FAILED'">
              Recalculation failed.
            </template>
          </p>
          <span
            ><strong>Job</strong>
            {{ awardRecalculation.jobId || awardRecalculation.id }}</span
          >
          <span
            class="status-pill"
            :class="(awardRecalculation.status || '').toLowerCase()"
            aria-hidden="true"
          >
            {{ awardRecalculation.status || 'QUEUED' }}
          </span>
          <span>{{ awardRecalculation.attempts ?? 0 }} attempts</span>
          <progress
            v-if="
              ['QUEUED', 'RUNNING'].includes(awardRecalculation.status || '')
            "
            aria-label="Award recalculation is running"
          />
          <button
            class="secondary"
            :disabled="awardRecalculationLoading"
            @click="refreshAwardRecalculation"
          >
            Refresh status
          </button>
          <p
            v-if="awardRecalculation.lastError"
            class="error-text"
            role="alert"
          >
            {{ awardRecalculation.lastError }}
          </p>
        </div>
        <p v-if="awardRecalculationError" class="error-text" role="alert">
          {{ awardRecalculationError }}
        </p>
      </section>
      <form class="form-grid" @submit.prevent="save">
        <label
          >Code<input
            id="award-code"
            v-model="form.code"
            :aria-invalid="hasAwardFieldError('code') ? 'true' : undefined"
            :readonly="!editable"
            required /></label
        ><label
          >Name<input
            id="award-name"
            v-model="form.name"
            :aria-invalid="hasAwardFieldError('name') ? 'true' : undefined"
            :readonly="!editable"
            required /></label
        ><label
          >Category<select
            id="award-category"
            v-model="form.category"
            :aria-invalid="hasAwardFieldError('category') ? 'true' : undefined"
            :disabled="!editable"
          >
            <option>HUNTER</option>
            <option>ACTIVATOR</option>
          </select></label
        ><label
          >Achievement metric<select
            id="award-achievement-metric"
            v-model="form.achievementMetric"
            :aria-invalid="
              hasAwardFieldError('achievementMetric') ? 'true' : undefined
            "
            :disabled="!editable"
          >
            <option>QSO_COUNT</option>
            <option>ACTIVATION_COUNT</option>
            <option>UNIQUE_CALLSIGNS</option>
            <option>UNIQUE_ENTITIES</option>
          </select></label
        ><label class="wide"
          >Description<textarea
            id="award-description"
            v-model="form.description"
            :aria-invalid="
              hasAwardFieldError('description') ? 'true' : undefined
            "
            :readonly="!editable"
          ></textarea></label
        ><label class="wide"
          >Award Text<textarea
            id="award-text"
            v-model="form.awardText"
            :aria-invalid="hasAwardFieldError('awardText') ? 'true' : undefined"
            :readonly="!editable"
            maxlength="200"
            rows="3"
          ></textarea
          ><small class="field-help"
            >Shown below the award name by default. Drag its layout element to
            reposition it.</small
          ></label
        ><label
          >Effective from (UTC)<input
            id="award-effective-from"
            v-model="form.effectiveFrom"
            :disabled="
              !canManage || (!editable && selected?.status !== 'APPROVED')
            "
            type="datetime-local" /></label
        ><label
          >Background object key<select
            id="award-background"
            v-model="form.backgroundKey"
            :aria-invalid="
              hasAwardFieldError('backgroundAsset') ? 'true' : undefined
            "
            :disabled="!editable"
            @change="chooseBackground"
          >
            <option value="">No background / blank preview</option>
            <option
              v-if="form.backgroundKey && !selectedBackground"
              :value="form.backgroundKey"
            >
              Existing background · {{ form.backgroundKey }}
            </option>
            <option
              v-for="asset in backgrounds"
              :key="asset.id"
              :value="asset.objectKey"
            >
              {{ asset.name }} · {{ asset.objectKey }}
            </option>
          </select></label
        ><label
          >Print background width (pixels)<input
            v-model.number="form.width"
            readonly
            type="number"
            min="1" /></label
        ><label
          >Print background height (pixels)<input
            v-model.number="form.height"
            readonly
            type="number"
            min="1" /></label
        ><label
          >Page<select
            id="award-page"
            v-model="form.page"
            :aria-invalid="hasAwardFieldError('printSpec') ? 'true' : undefined"
            :disabled="!editable"
          >
            <option>A4</option>
            <option>LETTER</option>
          </select></label
        ><label
          >Orientation<select
            id="award-orientation"
            v-model="form.orientation"
            :aria-invalid="hasAwardFieldError('printSpec') ? 'true' : undefined"
            :disabled="!editable"
          >
            <option>PORTRAIT</option>
            <option>LANDSCAPE</option>
          </select></label
        ><label
          >Resolution<input
            id="award-dpi"
            v-model.number="form.dpi"
            :aria-invalid="hasAwardFieldError('printSpec') ? 'true' : undefined"
            :readonly="!editable"
            type="number"
            min="150"
            max="300"
        /></label>
        <p class="field-help wide">
          Backgrounds are resized to these page dimensions with a centered crop;
          the registered source remains unchanged. The cropped source must
          retain at least 150 DPI of detail to publish.
        </p>
        ><label class="wide"
          >Award manager name<input
            id="award-manager-name"
            v-model="form.managerName"
            :readonly="!editable" /></label
        ><label class="wide"
          >Manager signature<select
            id="award-signature"
            v-model="form.signatureAssetId"
            :disabled="!editable"
          >
            <option value="">Mock signature / none selected</option>
            <option
              v-for="asset in signatures"
              :key="asset.id"
              :value="asset.id"
            >
              {{ asset.name }}
            </option>
          </select></label
        ><label class="wide"
          >Condition JSON<textarea
            id="award-condition"
            v-model="form.condition"
            :aria-invalid="hasAwardFieldError('condition') ? 'true' : undefined"
            :readonly="!editable"
            class="code-editor"
          ></textarea
          ><small class="field-help"
            >Programme-owned AND / OR condition tree.</small
          ></label
        ><label class="wide"
          >Levels JSON<textarea
            id="award-levels"
            v-model="form.levels"
            :aria-invalid="hasAwardFieldError('levels') ? 'true' : undefined"
            :readonly="!editable"
            class="code-editor"
          ></textarea
          ><small class="field-help"
            >Incremental thresholds such as 10, 50 and 100.</small
          ></label
        >
        <div class="form-actions wide">
          <button
            class="primary"
            :disabled="saving || !editable || !programme"
            type="submit"
          >
            {{
              saving
                ? 'Saving…'
                : editingPublished
                  ? 'Save new version as draft'
                  : 'Save award draft'
            }}</button
          ><button
            v-if="
              selected &&
              ['DRAFT', 'CHANGES_REQUESTED'].includes(selected.status || '')
            "
            class="secondary"
            type="button"
            :disabled="saving || !canManage"
            @click="action('submit')"
          >
            Submit for review</button
          ><button
            v-if="selected?.status === 'UNDER_REVIEW'"
            class="approve"
            type="button"
            :disabled="saving || !canManage"
            @click="action('review', 'APPROVED')"
          >
            Approve</button
          ><button
            v-if="selected?.status === 'UNDER_REVIEW'"
            class="reject"
            type="button"
            :disabled="saving || !canManage"
            @click="action('review', 'CHANGES_REQUESTED')"
          >
            Request changes</button
          ><button
            v-if="selected?.status === 'APPROVED'"
            class="primary"
            type="button"
            :disabled="saving || !canManage"
            @click="action('publish')"
          >
            Publish
          </button>
        </div>
      </form>
    </article>
  </div>
  <article class="panel">
    <div class="panel-heading">
      <div>
        <p class="eyebrow">CERTIFICATE LAYOUT</p>
        <h2>WYSIWYG placement</h2>
        <p class="muted">
          Drag certificate fields over the print background, or fine-tune their
          normalized coordinates below.
        </p>
      </div>
      <div class="toolbar">
        <button
          class="secondary"
          :disabled="!editable || saving"
          @click="addTemplateElement"
        >
          Add text element</button
        ><button
          class="secondary"
          :disabled="!editable || saving"
          @click="restoreDefaults"
        >
          Restore default elements</button
        ><button
          class="primary"
          :disabled="previewing || !canManage"
          @click="previewPdf"
        >
          {{ previewing ? 'Generating…' : 'Generate preview PDF' }}
        </button>
      </div>
    </div>
    <div id="award-template-layout" class="award-layout">
      <div
        class="award-canvas"
        :style="{ aspectRatio: canvasAspectRatio }"
        @pointermove="moveDrag"
        @pointerup="endDrag"
        @pointercancel="endDrag"
      >
        <div class="award-canvas-background">
          <img
            v-if="backgroundImage"
            :src="backgroundImage"
            alt="Selected award background"
          />
          <span v-else
            >{{ form.page }} · {{ form.orientation }} · {{ form.dpi }}</span
          >
        </div>
        <div
          v-for="(element, index) in templateElements"
          :key="`${element.kind}-${index}`"
          class="award-canvas-element"
          :style="{
            left: `${element.x * 100}%`,
            top: `${element.y * 100}%`,
            width: `${element.width * 100}%`,
            height: `${element.height * 100}%`,
          }"
          @pointerdown.stop="beginDrag($event, index)"
        >
          <img
            v-if="element.kind === 'MANAGER_SIGNATURE' && signatureImage"
            :src="signatureImage"
            alt="Selected manager signature"
          />
          <span v-else>{{ elementText(element) }}</span>
        </div>
      </div>
      <div class="award-elements">
        <div
          v-for="(element, index) in templateElements"
          :key="`${element.kind}-${index}`"
          class="award-element-row"
          :class="{ custom: element.kind === 'CUSTOM_TEXT' }"
        >
          <input
            v-if="element.kind === 'CUSTOM_TEXT'"
            v-model="element.label"
            :readonly="!editable"
            aria-label="Custom text"
            maxlength="200"
          /><strong v-else>{{ element.label }}</strong
          ><label
            >X<input
              v-model.number="element.x"
              :readonly="!editable"
              type="number"
              min="0"
              max="1"
              step=".01" /></label
          ><label
            >Y<input
              v-model.number="element.y"
              :readonly="!editable"
              type="number"
              min="0"
              max="1"
              step=".01" /></label
          ><label
            >W<input
              v-model.number="element.width"
              :readonly="!editable"
              type="number"
              min=".01"
              max="1"
              step=".01" /></label
          ><label
            >H<input
              v-model.number="element.height"
              :readonly="!editable"
              type="number"
              min=".01"
              max="1"
              step=".01"
          /></label>
          <button
            v-if="element.kind === 'CUSTOM_TEXT'"
            class="quiet"
            type="button"
            @click="removeTemplateElement(index)"
          >
            Remove
          </button>
        </div>
      </div>
    </div>
  </article>
  <div class="dashboard-grid">
    <article class="panel">
      <div class="panel-heading">
        <div>
          <h2>Registered assets</h2>
          <small class="muted">{{ assets.length }} image assets</small>
        </div>
      </div>
      <div class="table-list">
        <div v-for="asset in assets" :key="asset.id" class="table-row">
          <span
            ><strong>{{ asset.name }}</strong
            ><small>{{ asset.kind }} · {{ asset.objectKey }}</small></span
          ><span>{{ asset.widthPx }} × {{ asset.heightPx }} px</span>
        </div>
      </div>
    </article>
    <article class="panel">
      <div class="panel-heading"><h2>Requests and issuances</h2></div>
      <div class="table-list">
        <h3>Requests · {{ requestTotal }}</h3>
        <div v-if="canManage" class="form-grid">
          <label
            >Issuance manager name<input
              v-model="issueManagerName"
              maxlength="200"
          /></label>
          <label
            >Issuance signature<select v-model="issueSignatureAssetId">
              <option value="">Choose a registered signature…</option>
              <option
                v-for="asset in signatures"
                :key="asset.id"
                :value="asset.id"
              >
                {{ asset.name }}
              </option>
            </select></label
          >
          <small v-if="!signatures.length" class="field-help"
            >Upload a signature asset above to issue requested awards.</small
          >
        </div>
        <div v-for="request in requests" :key="request.id" class="table-row">
          <span
            ><strong>{{ request.callsign }} · {{ request.personName }}</strong
            ><small
              >{{ request.programmeSlug }} · {{ request.levelId }}</small
            ></span
          ><span class="status-pill">{{ request.status }}</span>
          <button
            v-if="request.status === 'REQUESTED' && canManage"
            type="button"
            :disabled="
              saving || !issueManagerName.trim() || !issueSignatureAssetId
            "
            @click="issueAwardRequest(request)"
          >
            Issue award for {{ request.callsign }}
          </button>
        </div>
        <p v-if="!requests.length" class="muted empty">No award requests.</p>
        <PageNavigation
          :page="requestPage"
          :next-page="
            requestPage * pageSize < requestTotal ? requestPage + 1 : null
          "
          :total="requestTotal"
          count-label="requests"
          :busy="loading"
          label="award requests"
          @change="setRequestPage"
        />
        <h3>Issuances · {{ issuanceTotal }}</h3>
        <div v-for="issuance in issuances" :key="issuance.id" class="table-row">
          <span
            ><strong>{{ issuance.awardName }}</strong
            ><small>{{ issuance.callsign }} · {{ issuance.levelId }}</small
            ><small>{{
              issuance.artifact?.downloadReady
                ? 'PDF ready'
                : issuance.renderJobStatus ||
                  renderQueueStatus[issuance.id] ||
                  'PDF not queued'
            }}</small></span
          ><span>{{ issuance.dateObtained }}</span>
          <button
            v-if="canManage && !issuance.artifact?.downloadReady"
            type="button"
            :disabled="saving || renderQueueStatus[issuance.id] === 'QUEUED'"
            @click="queueCertificateRender(issuance)"
          >
            Queue PDF render for {{ issuance.callsign }}
          </button>
        </div>
        <p v-if="!issuances.length" class="muted empty">No award issuances.</p>
        <PageNavigation
          :page="issuancePage"
          :next-page="
            issuancePage * pageSize < issuanceTotal ? issuancePage + 1 : null
          "
          :total="issuanceTotal"
          count-label="issuances"
          :busy="loading"
          label="award issuances"
          @change="setIssuancePage"
        />
      </div>
    </article>
  </div>
  <article class="panel">
    <div class="panel-heading">
      <div>
        <p class="eyebrow">ASSET MANAGEMENT</p>
        <h2>Upload signature or background</h2>
        <p class="muted">
          PNG and JPG images are uploaded through the authenticated API to
          SeaweedFS. Give backgrounds a descriptive name. Maximum 20 MiB and 16
          million pixels.
        </p>
      </div>
    </div>
    <form class="form-grid" @submit.prevent="registerAsset">
      <fieldset
        class="form-grid wide award-upload-fields"
        :disabled="uploading || !canManage"
      >
        <label
          >Asset type<select v-model="assetForm.kind">
            <option>SIGNATURE</option>
            <option>BACKGROUND</option>
          </select></label
        ><label>Display name<input v-model="assetForm.name" required /></label
        ><label
          >Object key<input
            v-model="assetForm.objectKey"
            placeholder="Generated automatically on upload"
            readonly /></label
        ><label
          >Media type<input v-model="assetForm.mediaType" readonly /></label
        ><label
          >Width<input
            v-model.number="assetForm.width"
            type="number"
            min="1"
            readonly /></label
        ><label
          >Height<input
            v-model.number="assetForm.height"
            type="number"
            min="1"
            readonly /></label
        ><label class="wide"
          >Image file<input
            type="file"
            accept="image/png,image/jpeg,.png,.jpg,.jpeg"
            required
            @change="selectAssetFile" /></label
        ><label class="wide"
          >SHA-256 checksum<input v-model="assetForm.sha256"
        /></label>
        <div class="form-actions wide">
          <button
            class="primary"
            :disabled="uploading || !assetFile"
            type="submit"
          >
            {{ uploading ? 'Uploading…' : 'Upload image asset' }}
          </button>
        </div>
      </fieldset>
    </form>
  </article>
</template>
