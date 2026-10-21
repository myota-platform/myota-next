<script setup lang="ts">
import PageHeader from '../components/PageHeader.vue';
import { computed, onMounted, reactive, ref } from 'vue';
import { apiRequest } from '../lib/api';
import { myotaClient } from '../lib/myotaClient';
import { useAppStore } from '../stores/app';
import type { EntityCategory, Programme } from '../types';

const store = useAppStore();
const programmes = ref<Programme[]>([]);
const categories = ref<EntityCategory[]>([]);
const selected = ref<Programme | null>(null);
const saving = ref(false);
const loadingEditor = ref(false);
const error = ref('');
let selectionRequest = 0;
const message = ref('');
const categorySelection = ref('');
const categoryMutationStorageKey = 'myota_admin_pending_category_mutations';
const pendingCategoryMutationKeys = restoreCategoryMutationKeys();
const form = reactive({
  slug: '',
  name: '',
  description: '',
  activationQsos: 0,
  hunterQsos: 0,
  validityMode: 'unlimited',
  validityDays: '',
  publicAccess: false,
  excludeOverlaps: false,
  entityTypes: [] as EntityCategory[],
  primary: '#0f766e',
  accent: '#f59e0b',
});

function restoreCategoryMutationKeys(): Map<string, string> {
  try {
    const saved = JSON.parse(
      sessionStorage.getItem(categoryMutationStorageKey) || '[]',
    );
    return new Map(
      Array.isArray(saved)
        ? saved.filter(
            (entry: unknown) =>
              Array.isArray(entry) &&
              typeof entry[0] === 'string' &&
              typeof entry[1] === 'string',
          )
        : [],
    );
  } catch {
    return new Map();
  }
}

function persistCategoryMutationKeys(): void {
  try {
    sessionStorage.setItem(
      categoryMutationStorageKey,
      JSON.stringify([...pendingCategoryMutationKeys.entries()]),
    );
  } catch {
    // In-memory retry keys remain available when browser storage is unavailable.
  }
}

const availableCategories = computed(() =>
  categories.value.filter(
    (category) =>
      !form.entityTypes.some((item) => item.code === category.code) &&
      category.active !== false,
  ),
);

function resetForm(programme: Programme | null = null): void {
  // API records are JSON. Clone before assigning them to a reactive ref:
  // structuredClone cannot clone Vue proxies, including category arrays.
  const snapshot = programme ? JSON.parse(JSON.stringify(programme)) : null;
  selected.value = snapshot;
  programme = snapshot;
  categorySelection.value = '';
  const rules = (programme as any)?.rules || {};
  Object.assign(form, {
    slug: programme?.slug || '',
    name: programme?.name || '',
    description: programme?.description || '',
    activationQsos: rules.minimumQsos?.activation || 0,
    hunterQsos: rules.minimumQsos?.hunter || 0,
    validityMode: rules.activationValidityDays == null ? 'unlimited' : 'finite',
    validityDays:
      rules.activationValidityDays == null
        ? ''
        : String(rules.activationValidityDays),
    publicAccess: Boolean(rules.publicAccessRequired),
    excludeOverlaps: Boolean(rules.excludeOverlappingProgrammes),
    entityTypes: (programme as any)?.entityTypes || [],
    primary: (programme as any)?.theme?.primary || '#0f766e',
    accent: (programme as any)?.theme?.accent || '#f59e0b',
  });
}

async function load(refreshProgrammes = false): Promise<void> {
  error.value = '';
  await Promise.all([
    (refreshProgrammes || !store.programmes.length
      ? store.loadProgrammes()
      : Promise.resolve()
    ).then(() => {
      programmes.value = store.programmes;
    }),
    apiRequest<{ items: EntityCategory[] }>('/v1/entity-types')
      .then((data) => {
        categories.value = data.items || [];
      })
      .catch(() => {
        error.value =
          'Category choices could not be refreshed. Existing programme data remains available.';
      }),
  ]);
}

async function edit(programme: Programme): Promise<void> {
  const request = ++selectionRequest;
  loadingEditor.value = true;
  error.value = '';
  try {
    const record = await apiRequest<Programme>(
      `/v1/programmes/${encodeURIComponent(programme.slug)}`,
    );
    if (request === selectionRequest) resetForm(record);
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : 'Unable to load programme.';
  } finally {
    if (request === selectionRequest) loadingEditor.value = false;
  }
}

async function assignCategory(category: EntityCategory): Promise<void> {
  if (selected.value) {
    const programmeSlug = selected.value.slug;
    const requestId = JSON.stringify([
      store.account?.id,
      'assign',
      programmeSlug,
      category.code,
    ]);
    let idempotencyKey = pendingCategoryMutationKeys.get(requestId);
    if (!idempotencyKey) {
      idempotencyKey = crypto.randomUUID();
      pendingCategoryMutationKeys.set(requestId, idempotencyKey);
      persistCategoryMutationKeys();
    }
    try {
      const response = await myotaClient.assignProgrammeEntityCategory<{
        items: EntityCategory[];
      }>(programmeSlug, category.code, idempotencyKey);
      if (selected.value?.slug === programmeSlug) {
        form.entityTypes = response.items || [
          ...form.entityTypes,
          JSON.parse(JSON.stringify(category)),
        ];
        (selected.value as any).entityTypes = form.entityTypes;
      }
      pendingCategoryMutationKeys.delete(requestId);
      persistCategoryMutationKeys();
      message.value = 'Category assigned.';
    } catch (cause) {
      error.value =
        cause instanceof Error ? cause.message : 'Unable to assign category.';
    }
  } else form.entityTypes.push(JSON.parse(JSON.stringify(category)));
  categorySelection.value = '';
}
async function removeCategory(code: string): Promise<void> {
  if (selected.value) {
    const programmeSlug = selected.value.slug;
    const requestId = JSON.stringify([
      store.account?.id,
      'unassign',
      programmeSlug,
      code,
    ]);
    let idempotencyKey = pendingCategoryMutationKeys.get(requestId);
    if (!idempotencyKey) {
      idempotencyKey = crypto.randomUUID();
      pendingCategoryMutationKeys.set(requestId, idempotencyKey);
      persistCategoryMutationKeys();
    }
    try {
      const response = await myotaClient.unassignProgrammeEntityCategory<{
        items: EntityCategory[];
      }>(programmeSlug, code, idempotencyKey);
      if (selected.value?.slug === programmeSlug) {
        form.entityTypes =
          response.items ||
          form.entityTypes.filter((item) => item.code !== code);
        (selected.value as any).entityTypes = form.entityTypes;
      }
      pendingCategoryMutationKeys.delete(requestId);
      persistCategoryMutationKeys();
      message.value = 'Category unassigned.';
    } catch (cause) {
      error.value =
        cause instanceof Error ? cause.message : 'Unable to unassign category.';
    }
  } else
    form.entityTypes = form.entityTypes.filter((item) => item.code !== code);
}
async function assignSelectedCategory(): Promise<void> {
  const category = categories.value.find(
    (item) => item.code === categorySelection.value,
  );
  if (category) await assignCategory(category);
}

async function save(): Promise<void> {
  message.value = '';
  if (!form.slug.trim() || !form.name.trim()) {
    error.value = 'Programme identifier and name are required.';
    return;
  }
  if (
    form.validityMode === 'finite' &&
    (!Number.isInteger(Number(form.validityDays)) ||
      Number(form.validityDays) < 1)
  ) {
    error.value = 'Enter a positive validity period or choose Unlimited.';
    return;
  }
  saving.value = true;
  try {
    const existing = selected.value as any;
    const payload: Record<string, unknown> = {
      slug: selected.value?.slug || form.slug.trim().toLowerCase(),
      name: form.name.trim(),
      description: form.description,
      rules: {
        ...existing?.rules,
        minimumQsos: {
          ...existing?.rules?.minimumQsos,
          activation: Number(form.activationQsos),
          hunter: Number(form.hunterQsos),
        },
        activationValidityDays:
          form.validityMode === 'unlimited' ? null : Number(form.validityDays),
        publicAccessRequired: form.publicAccess,
        excludeOverlappingProgrammes: form.excludeOverlaps,
      },
      theme: { ...existing?.theme, primary: form.primary, accent: form.accent },
    };
    if (!selected.value) payload.entityTypes = form.entityTypes;
    const saved = selected.value
      ? await myotaClient.patchProgramme<Programme>(
          selected.value.slug,
          payload,
        )
      : await apiRequest<Programme>('/v1/programmes', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'Idempotency-Key': crypto.randomUUID() },
        });
    await load(true);
    resetForm(saved);
    message.value = 'Programme saved.';
  } catch (cause) {
    message.value = '';
    error.value =
      cause instanceof Error ? cause.message : 'Unable to save programme.';
  } finally {
    saving.value = false;
  }
}

async function archive(): Promise<void> {
  if (!selected.value || !window.confirm(`Archive ${selected.value.slug}?`))
    return;
  await myotaClient.patchProgramme(selected.value.slug, { status: 'ARCHIVED' });
  await load(true);
  resetForm();
}

resetForm();
onMounted(() =>
  load().catch((cause) => {
    error.value = String(cause);
  }),
);
</script>

<template>
  <PageHeader :refresh="() => load(true)" :busy="saving || loadingEditor"
    ><button
      class="primary"
      :disabled="saving"
      @click="
        selectionRequest++;
        loadingEditor = false;
        resetForm();
      "
    >
      New programme
    </button></PageHeader
  >
  <div v-if="message" class="notice" role="status">{{ message }}</div>
  <div v-if="error" class="error-card" role="alert">{{ error }}</div>
  <p v-if="loadingEditor" class="notice" role="status">Loading programme…</p>
  <div class="split-layout">
    <article class="panel">
      <div class="panel-heading">
        <h2>Configured programmes</h2>
      </div>
      <div class="table-list">
        <button
          v-for="programme in programmes"
          :key="programme.slug"
          class="table-row"
          :class="{ selected: selected?.slug === programme.slug }"
          @click="edit(programme)"
        >
          <span
            ><strong>{{ programme.name }}</strong
            ><small
              >{{ programme.slug }} · policy v{{
                (programme as any).policyVersion || 1
              }}</small
            ></span
          ><span
            class="status-pill"
            :class="(programme.status || '').toLowerCase()"
            >{{ programme.status }}</span
          >
        </button>
        <p v-if="!programmes.length" class="muted empty">
          No programmes configured.
        </p>
      </div>
    </article>
    <article class="panel">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">PROGRAMME EDITOR</p>
          <h2>{{ selected ? `Edit ${selected.name}` : 'New programme' }}</h2>
        </div>
        <span v-if="selected" class="status-pill approved"
          >POLICY V{{ (selected as any).policyVersion || 1 }}</span
        >
      </div>
      <form
        class="form-grid programme-form"
        :aria-busy="loadingEditor || saving"
        @submit.prevent="save"
      >
        <label
          >Programme identifier<input
            v-model="form.slug"
            :readonly="Boolean(selected)"
            required
          /><small class="field-help"
            >Permanent lowercase identifier used in URLs and API
            references.</small
          ></label
        ><label>Programme name<input v-model="form.name" required /></label
        ><label class="wide"
          >Description<textarea v-model="form.description"></textarea>
        </label>
        <section class="form-section wide">
          <div class="section-heading">
            <h3>Programme policy</h3>
            <span class="help-badge">Programme-owned</span>
          </div>
          <p class="field-help">
            MyOTA supplies the configuration mechanism; each programme defines
            its own values.
          </p>
          <div class="form-grid nested-grid">
            <label
              >Minimum activation QSOs<input
                v-model.number="form.activationQsos"
                type="number"
                min="0" /></label
            ><label
              >Minimum hunter QSOs<input
                v-model.number="form.hunterQsos"
                type="number"
                min="0" /></label
            ><label
              >Activation validity<select v-model="form.validityMode">
                <option value="unlimited">Unlimited</option>
                <option value="finite">Limited number of days</option>
              </select></label
            ><label v-if="form.validityMode === 'finite'"
              >Validity days<input
                v-model="form.validityDays"
                type="number"
                min="1" /></label
            ><label class="check-field wide"
              ><input v-model="form.publicAccess" type="checkbox" /><span
                >Require public access</span
              ></label
            ><label class="check-field wide"
              ><input v-model="form.excludeOverlaps" type="checkbox" /><span
                >Exclude overlapping programmes</span
              ></label
            >
          </div>
        </section>
        <section class="form-section wide">
          <div class="section-heading">
            <h3>Entity category assignments</h3>
            <span class="help-badge">Shared master data</span>
          </div>
          <p class="field-help">
            One category may belong to multiple programmes. Assignments are
            persisted immediately through the programme assignment API.
          </p>
          <div class="chip-list">
            <span
              v-for="category in form.entityTypes"
              :key="category.code"
              class="chip"
              >{{ category.label || category.code }}
              <button
                type="button"
                :aria-label="`Remove ${category.code}`"
                @click="removeCategory(category.code)"
              >
                ×
              </button></span
            ><span v-if="!form.entityTypes.length" class="muted"
              >No categories assigned.</span
            >
          </div>
          <select v-model="categorySelection" @change="assignSelectedCategory">
            <option value="">Assign shared category…</option>
            <option
              v-for="category in availableCategories"
              :key="category.code"
              :value="category.code"
            >
              {{ category.label || category.code }}
            </option>
          </select>
        </section>
        <section class="form-section wide">
          <div class="section-heading"><h3>Programme appearance</h3></div>
          <div class="form-grid nested-grid">
            <label
              >Primary colour<input
                v-model="form.primary"
                type="color" /></label
            ><label
              >Accent colour<input v-model="form.accent" type="color"
            /></label>
          </div>
        </section>
        <div class="form-actions wide">
          <button
            class="primary"
            :disabled="saving || loadingEditor"
            type="submit"
          >
            {{ saving ? 'Saving…' : 'Save programme' }}</button
          ><button
            v-if="selected"
            class="danger-outline"
            type="button"
            @click="archive"
          >
            Archive programme
          </button>
        </div>
      </form>
    </article>
  </div>
</template>
