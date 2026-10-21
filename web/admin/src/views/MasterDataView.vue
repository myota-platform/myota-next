<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { apiRequest } from '../lib/api';
import type { EntityCategory } from '../types';
import PageHeader from '../components/PageHeader.vue';
import PageFeedback from '../components/PageFeedback.vue';
import { usePageFeedback } from '../composables/usePageFeedback';
import { hasAnyScope } from '../lib/adminAccess';
import { createPendingIdempotencyKeys } from '../lib/pendingIdempotencyKeys';
import { useAppStore } from '../stores/app';
const store = useAppStore();
const canEdit = computed(() => hasAnyScope(store.account, 'programme.admin'));
const feedback = usePageFeedback();
const { error, message, loading, saving } = feedback;
const pendingMutationKeys = createPendingIdempotencyKeys(
  'myota_admin_pending_master_data_mutations',
);
const geometryTypes = [
  'POINT',
  'LINESTRING',
  'MULTILINESTRING',
  'POLYGON',
  'MULTIPOLYGON',
];
const labels: Record<string, string> = {
  POINT: 'Point',
  LINESTRING: 'LineString',
  MULTILINESTRING: 'MultiLineString',
  POLYGON: 'Polygon',
  MULTIPOLYGON: 'MultiPolygon',
};
const items = ref<EntityCategory[]>([]);
const selected = ref<EntityCategory | null>(null);
const form = reactive({
  code: '',
  label: '',
  description: '',
  active: true,
  geometryTypes: ['MULTIPOLYGON'],
});
function edit(item: EntityCategory | null): void {
  selected.value = item;
  Object.assign(form, {
    code: item?.code || '',
    label: item?.label || '',
    description: item?.description || '',
    active: item?.active !== false,
    geometryTypes: [
      ...(item?.geometryTypes ||
        (item?.geometry ? [item.geometry] : ['MULTIPOLYGON'])),
    ],
  });
}
async function fetchItems(selectedCode?: string | Event): Promise<void> {
  const code = typeof selectedCode === 'string' ? selectedCode : undefined;
  const data = await apiRequest<{ items: EntityCategory[] }>(
    '/v1/entity-types',
  );
  items.value = data.items || [];
  if (code) edit(items.value.find((item) => item.code === code) || null);
}
async function load(): Promise<void> {
  await feedback.run(() => fetchItems(selected.value?.code));
}
async function save(): Promise<void> {
  if (!canEdit.value) return;
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(form.code)) {
    error.value =
      'Category code must use uppercase letters, numbers, and underscores.';
    return;
  }
  if (!form.geometryTypes.length) {
    error.value = 'Select at least one geometry type.';
    return;
  }
  await feedback.run(
    async () => {
      const requestPath = '/v1/entity-types';
      const requestBody = {
        code: form.code,
        originalCode: selected.value?.code || form.code,
        label: form.label,
        description: form.description,
        active: form.active,
        geometryTypes: form.geometryTypes,
      };
      const fingerprint = JSON.stringify([
        store.account?.id,
        requestPath,
        requestBody,
      ]);
      await apiRequest(requestPath, {
        method: 'POST',
        body: JSON.stringify(requestBody),
        headers: {
          'Idempotency-Key': pendingMutationKeys.getOrCreate(fingerprint),
        },
      });
      pendingMutationKeys.complete(fingerprint);
      await fetchItems(form.code);
    },
    { mutation: true, success: 'Category saved.' },
  );
}
onMounted(() => load());
</script>

<style scoped>
.master-data-form > label {
  align-content: start;
}
</style>

<template>
  <PageHeader :refresh="load" :busy="loading || saving"
    ><button
      v-if="canEdit"
      class="primary"
      :disabled="saving || loading"
      @click="edit(null)"
    >
      New category
    </button></PageHeader
  >
  <p class="scope-description">
    Shared catalogue · programme assignments are managed in
    <RouterLink to="/programmes">Programmes</RouterLink>.
  </p>
  <PageFeedback :error="error" :message="message" :loading="loading" />
  <div class="split-layout">
    <article class="panel">
      <div class="panel-heading"><h2>Entity categories</h2></div>
      <div class="table-list">
        <button
          v-for="item in items"
          :key="item.code"
          class="table-row"
          :class="{ selected: selected?.code === item.code }"
          @click="edit(item)"
        >
          <span
            ><strong>{{ item.label || item.code }}</strong
            ><small
              ><code>{{ item.code }}</code> ·
              {{
                (item.geometryTypes || [])
                  .map((type) => labels[type] || type)
                  .join(', ')
              }}</small
            ><small
              >{{ item.active === false ? 'Inactive' : 'Active' }} ·
              {{ item.assignedProgrammes?.length || 0 }} programme(s)</small
            ></span
          ><span
            class="status-pill"
            :class="item.active === false ? 'muted-pill' : 'approved'"
            >{{ item.active === false ? 'Inactive' : 'Active' }}</span
          >
        </button>
        <p v-if="!items.length" class="muted empty">
          No shared categories configured.
        </p>
      </div>
    </article>
    <article class="panel">
      <div class="panel-heading">
        <h2>
          {{
            selected
              ? `Edit ${selected.label || selected.code}`
              : 'New category'
          }}
        </h2>
      </div>
      <p v-if="!canEdit" class="read-only-note">
        Read-only catalogue. Changing shared categories requires programme
        administration permission.
      </p>
      <form class="form-grid master-data-form" @submit.prevent="save">
        <fieldset
          class="editor-fields wide form-grid"
          :disabled="!canEdit || saving"
        >
          <label
            >Category code<input
              v-model="form.code"
              :readonly="Boolean(selected)"
              required
            /><small class="field-help"
              >Stable identifier. Codes cannot be renamed after creation.</small
            ></label
          ><label>Display name<input v-model="form.label" required /></label>
          <fieldset class="wide">
            <legend>Allowed geometry types</legend>
            <div class="checkbox-grid">
              <label
                v-for="type in geometryTypes"
                :key="type"
                class="check-field"
                ><input
                  v-model="form.geometryTypes"
                  type="checkbox"
                  :value="type"
                /><span>{{ labels[type] }}</span></label
              >
            </div>
          </fieldset>
          <label
            >Availability<select v-model="form.active">
              <option :value="true">Active — available for new entities</option>
              <option :value="false">
                Inactive — retain historical entities
              </option>
            </select></label
          ><label class="wide"
            >Description<textarea v-model="form.description"></textarea>
          </label>
          <div v-if="canEdit" class="form-actions wide">
            <button class="primary" type="submit">Save category</button
            ><button class="secondary" type="button" @click="edit(null)">
              Clear form
            </button>
          </div>
        </fieldset>
      </form>
    </article>
  </div>
  <article class="panel">
    <div class="panel-heading"><h2>Shared category rules</h2></div>
    <div class="info-grid">
      <p>
        <strong>Stable code</strong><br /><span class="muted"
          >Stored with entities and referenced by programme rules and
          awards.</span
        >
      </p>
      <p>
        <strong>Multiple geometries</strong><br /><span class="muted"
          >A category may permit Point, LineString, MultiLineString, Polygon and
          MultiPolygon.</span
        >
      </p>
      <p>
        <strong>Inactive lifecycle</strong><br /><span class="muted"
          >Existing records retain historical categories while new assignments
          are prevented.</span
        >
      </p>
    </div>
  </article>
</template>
