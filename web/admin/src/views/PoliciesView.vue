<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { apiRequest } from '../lib/api';
import { myotaClient } from '../lib/myotaClient';
import { useAppStore } from '../stores/app';
import { utcInput, utcInputValue } from '../lib/utc';

import PageHeader from '../components/PageHeader.vue';
import PageFeedback from '../components/PageFeedback.vue';
import ProgrammeScope from '../components/ProgrammeScope.vue';
import { usePageFeedback } from '../composables/usePageFeedback';
interface Policy {
  id?: string;
  type: string;
  name: string;
  schema?: unknown;
  effectiveFrom?: string;
  status?: string;
}
interface Page<T> {
  items: T[];
  page: number;
  total: number;
  nextPage: number | null;
}
const store = useAppStore();
const policies = ref<Policy[]>([]);
const policyPage = ref(1);
const policyNextPage = ref<number | null>(null);
const policyTotal = ref(0);
const selected = ref<Policy | null>(null);
const feedback = usePageFeedback();
const { error, message, loading, saving } = feedback;
const editable = computed(
  () =>
    !selected.value ||
    ['DRAFT', 'CHANGES_REQUESTED'].includes(selected.value.status || ''),
);
let generation = 0;

const form = reactive({
  type: 'RULES',
  name: '',
  effectiveFrom: '',
  schema:
    '{\n  "rules": {\n    "minimumQsos": { "activation": 0, "hunter": 0 }\n  }\n}',
});
const programme = ref(
  store.currentProgramme || store.programmes[0]?.slug || '',
);
function edit(policy: Policy | null): void {
  selected.value = policy ? JSON.parse(JSON.stringify(policy)) : null;
  Object.assign(form, {
    type: policy?.type || 'RULES',
    name: policy?.name || '',
    effectiveFrom: utcInput(policy?.effectiveFrom),
    schema: JSON.stringify(
      policy?.schema || {
        rules: { minimumQsos: { activation: 0, hunter: 0 } },
      },
      null,
      2,
    ),
  });
}
async function fetchItems(
  selectedId?: string | Event,
  requestedPage = policyPage.value,
): Promise<void> {
  if (!programme.value) return;
  const current = ++generation;
  const id = typeof selectedId === 'string' ? selectedId : undefined;
  const data = await apiRequest<Page<Policy>>(
    `/v1/programmes/${encodeURIComponent(programme.value)}/policy-drafts?page=${requestedPage}&pageSize=50`,
  );
  if (current !== generation) return;
  policies.value = data.items || [];
  policyPage.value = data.page || requestedPage;
  policyTotal.value = data.total || 0;
  policyNextPage.value = data.nextPage ?? null;
  if (id) edit(policies.value.find((item) => item.id === id) || null);
}
async function load(): Promise<void> {
  await feedback.run(() => fetchItems(selected.value?.id));
}
async function changePolicyPage(page: number): Promise<void> {
  if (page < 1 || loading.value || saving.value) return;
  await feedback.run(async () => {
    edit(null);
    await fetchItems(undefined, page);
  });
}
async function save(): Promise<void> {
  if (!editable.value || !programme.value) return;
  await feedback.run(
    async () => {
      const creating = !selected.value?.id;
      const saved = await apiRequest<Policy>(
        `/v1/programmes/${encodeURIComponent(programme.value)}/policy-drafts`,
        {
          method: 'POST',
          body: JSON.stringify({
            draftId: selected.value?.id,
            type: form.type,
            name: form.name.trim(),
            schema: JSON.parse(form.schema),
            effectiveFrom: utcInputValue(
              form.effectiveFrom,
              selected.value?.effectiveFrom,
            ),
          }),
        },
      );
      if (creating) policyPage.value = 1;
      await fetchItems(saved.id);
    },
    { mutation: true, success: 'Policy draft saved.' },
  );
}
async function action(action: string, decision?: string): Promise<void> {
  const record = selected.value;
  if (!record?.id) return;
  const id = record.id;
  await feedback.run(
    async () => {
      if (action === 'publish' && !form.effectiveFrom)
        throw new Error('Choose an effective date before publishing.');
      const body =
        action === 'review'
          ? {
              status: decision,
              reviewerId: store.account?.id,
              note: 'Reviewed in programme administration',
            }
          : action === 'publish'
            ? {
                status: 'PUBLISHED',
                effectiveFrom: utcInputValue(
                  form.effectiveFrom,
                  record.effectiveFrom,
                ),
                publisherId: store.account?.id,
              }
            : { status: 'UNDER_REVIEW', submitterId: store.account?.id };
      await myotaClient.patchProgrammePolicyDraft(programme.value, id, body);
      message.value = `Policy ${action === 'publish' ? 'published' : action === 'review' ? 'reviewed' : 'submitted for review'}.`;
      await fetchItems(id);
    },
    { mutation: true },
  );
}
watch(programme, () => {
  generation++;
  policyPage.value = 1;
  edit(null);
  policies.value = [];
  store.currentProgramme = programme.value;
  void load();
});
onMounted(() => {
  store.currentProgramme = programme.value;
  void load();
});
</script>

<template>
  <PageHeader :refresh="load" :busy="loading || saving"
    ><button
      class="primary"
      :disabled="loading || saving || !programme"
      @click="edit(null)"
    >
      New draft
    </button></PageHeader
  >
  <ProgrammeScope v-model="programme" :disabled="loading || saving" />
  <PageFeedback :error="error" :message="message" :loading="loading" />
  <div class="split-layout">
    <article class="panel">
      <div class="panel-heading">
        <h2>Policy drafts</h2>
        <span class="muted"
          >{{ policyTotal }} drafts · page {{ policyPage }}</span
        >
      </div>
      <div class="table-list">
        <button
          v-for="item in policies"
          :key="item.id"
          class="table-row"
          :class="{ selected: selected?.id === item.id }"
          @click="edit(item)"
        >
          <span
            ><strong>{{ item.name }}</strong
            ><small
              >{{ item.type }} ·
              {{ item.effectiveFrom || 'No effective date' }}</small
            ></span
          ><span
            class="status-pill"
            :class="(item.status || '').toLowerCase()"
            >{{ item.status }}</span
          >
        </button>
        <p v-if="!policies.length" class="muted empty">No drafts yet.</p>
      </div>
      <div class="toolbar policy-pagination">
        <button
          class="secondary"
          :disabled="policyPage <= 1 || loading || saving"
          @click="changePolicyPage(policyPage - 1)"
        >
          Previous
        </button>
        <button
          class="secondary"
          :disabled="policyNextPage === null || loading || saving"
          @click="changePolicyPage(policyNextPage || policyPage)"
        >
          Next
        </button>
      </div>
    </article>
    <article class="panel">
      <div class="panel-heading">
        <h2>{{ selected ? selected.name : 'New rule or award draft' }}</h2>
        <span
          v-if="selected"
          class="status-pill"
          :class="(selected.status || '').toLowerCase()"
          >{{ selected.status }}</span
        >
      </div>
      <p v-if="!editable" class="read-only-note" role="status">
        This version is read-only. Create a new draft to change its contents;
        review and publication actions remain available where applicable.
      </p>
      <form class="form-grid" :aria-busy="saving" @submit.prevent="save">
        <label
          >Policy type<select
            v-model="form.type"
            :disabled="!editable || saving"
          >
            <option value="RULES">Rules</option>
            <option value="AWARD">Award</option>
          </select></label
        ><label
          >Name<input
            v-model="form.name"
            :readonly="!editable || saving"
            required /></label
        ><label
          >Effective from (UTC)<input
            v-model="form.effectiveFrom"
            :disabled="saving || (!editable && selected?.status !== 'APPROVED')"
            type="datetime-local" /></label
        ><label class="wide"
          >Programme-owned schema (JSON)<textarea
            v-model="form.schema"
            :readonly="!editable || saving"
            class="code-editor"
            required
          ></textarea
          ><small class="field-help"
            >The programme owns the schema and its meaning. Published versions
            are immutable.</small
          ></label
        >
        <div class="form-actions wide">
          <button
            v-if="editable"
            class="primary"
            type="submit"
            :disabled="saving || loading || !programme"
          >
            {{ saving ? 'Saving…' : 'Save draft' }}</button
          ><button
            v-if="
              selected &&
              ['DRAFT', 'CHANGES_REQUESTED'].includes(selected.status || '')
            "
            class="secondary"
            type="button"
            :disabled="saving || loading"
            @click="action('submit')"
          >
            Submit for review</button
          ><button
            v-if="selected?.status === 'UNDER_REVIEW'"
            class="approve"
            type="button"
            :disabled="saving || loading"
            @click="action('review', 'APPROVED')"
          >
            Approve</button
          ><button
            v-if="selected?.status === 'UNDER_REVIEW'"
            class="reject"
            type="button"
            :disabled="saving || loading"
            @click="action('review', 'CHANGES_REQUESTED')"
          >
            Request changes</button
          ><button
            v-if="selected?.status === 'APPROVED'"
            class="primary"
            type="button"
            @click="action('publish')"
          >
            Publish
          </button>
        </div>
      </form>
    </article>
  </div>
</template>
