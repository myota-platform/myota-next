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
interface ContentItem {
  id?: string;
  key: string;
  locale: string;
  fallbackLocale?: string;
  value: string;
  status?: string;
  effectiveFrom?: string;
}
const store = useAppStore();
const programme = ref(
  store.currentProgramme || store.programmes[0]?.slug || '',
);
const items = ref<ContentItem[]>([]);
const coverage = ref<any[]>([]);
const selected = ref<ContentItem | null>(null);
const feedback = usePageFeedback();
const { error, message, loading, saving } = feedback;
const editable = computed(
  () =>
    !selected.value ||
    ['DRAFT', 'CHANGES_REQUESTED'].includes(selected.value.status || ''),
);
let generation = 0;

const form = reactive({
  key: '',
  locale: 'en',
  fallbackLocale: '',
  value: '',
  effectiveFrom: '',
});
function edit(item: ContentItem | null): void {
  selected.value = item ? JSON.parse(JSON.stringify(item)) : null;
  Object.assign(form, {
    key: item?.key || '',
    locale: item?.locale || 'en',
    fallbackLocale: item?.fallbackLocale || '',
    value: item?.value || '',
    effectiveFrom: utcInput(item?.effectiveFrom),
  });
}
async function fetchItems(selectedId?: string | Event): Promise<void> {
  if (!programme.value) return;
  const current = ++generation;
  const id = typeof selectedId === 'string' ? selectedId : undefined;
  const [data, coverageData] = await Promise.all([
    apiRequest<{ items: ContentItem[] }>(
      `/v1/programmes/${encodeURIComponent(programme.value)}/content?pageSize=100`,
    ),
    apiRequest<{ locales: any[] }>(
      `/v1/programmes/${encodeURIComponent(programme.value)}/content/coverage`,
    ),
  ]);
  if (current !== generation) return;
  items.value = data.items || [];
  coverage.value = coverageData.locales || [];
  if (id) edit(items.value.find((item) => item.id === id) || null);
}
async function load(): Promise<void> {
  await feedback.run(() => fetchItems(selected.value?.id));
}
async function save(): Promise<void> {
  if (!editable.value || !programme.value) return;
  await feedback.run(
    async () => {
      const saved = await apiRequest<ContentItem>(
        `/v1/programmes/${encodeURIComponent(programme.value)}/content`,
        {
          method: 'POST',
          body: JSON.stringify({
            contentId: selected.value?.id,
            key: form.key.trim(),
            locale: form.locale.trim(),
            fallbackLocale: form.fallbackLocale.trim() || null,
            value: form.value,
          }),
        },
      );
      await fetchItems(saved.id);
    },
    { mutation: true, success: 'Content draft saved.' },
  );
}
async function action(actionName: string, decision?: string): Promise<void> {
  const record = selected.value;
  if (!record?.id) return;
  const id = record.id;
  await feedback.run(
    async () => {
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
                  record.effectiveFrom,
                ),
                publisherId: store.account?.id,
              }
            : { status: 'UNDER_REVIEW', submitterId: store.account?.id };
      await myotaClient.patchProgrammeContent(programme.value, id, body);
      message.value = `Content ${actionName === 'publish' ? 'published' : actionName === 'review' ? 'reviewed' : 'submitted for review'}.`;
      await fetchItems(id);
    },
    { mutation: true },
  );
}
watch(programme, () => {
  generation++;
  edit(null);
  items.value = [];
  coverage.value = [];
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
      New content draft
    </button></PageHeader
  >
  <ProgrammeScope v-model="programme" :disabled="loading || saving" />
  <PageFeedback :error="error" :message="message" :loading="loading" />
  <article class="panel">
    <div class="panel-heading">
      <div>
        <h2>Locale coverage</h2>
        <small class="muted"
          >Published keys only; drafts remain visible below.</small
        >
      </div>
    </div>
    <div class="coverage-grid">
      <div
        v-for="locale in coverage"
        :key="locale.locale"
        class="coverage-card"
      >
        <strong>{{ locale.locale }}</strong
        ><span>{{ locale.coveragePercent }}%</span
        ><small>{{ locale.published }} of {{ locale.total }} published</small>
      </div>
      <p v-if="!coverage.length" class="muted empty">No content keys yet.</p>
    </div>
  </article>
  <div class="split-layout">
    <article class="panel">
      <div class="panel-heading"><h2>Content versions</h2></div>
      <div class="table-list">
        <button
          v-for="item in items"
          :key="item.id"
          class="table-row"
          :class="{ selected: selected?.id === item.id }"
          @click="edit(item)"
        >
          <span
            ><strong>{{ item.key }}</strong
            ><small
              >{{ item.locale
              }}<span v-if="item.fallbackLocale">
                · fallback {{ item.fallbackLocale }}</span
              ></small
            ></span
          ><span
            class="status-pill"
            :class="(item.status || '').toLowerCase()"
            >{{ item.status }}</span
          >
        </button>
        <p v-if="!items.length" class="muted empty">No content drafts yet.</p>
      </div>
    </article>
    <article class="panel">
      <div class="panel-heading">
        <h2>{{ selected ? selected.key : 'New content draft' }}</h2>
      </div>
      <p v-if="!editable" class="read-only-note" role="status">
        This version is read-only. Create a new draft to change its contents;
        review and publication actions remain available where applicable.
      </p>
      <form class="form-grid" :aria-busy="saving" @submit.prevent="save">
        <label
          >Content key<input
            v-model="form.key"
            :readonly="!editable || saving"
            required /></label
        ><label
          >Locale<input
            v-model="form.locale"
            :readonly="!editable || saving"
            required /></label
        ><label
          >Fallback locale<input
            v-model="form.fallbackLocale"
            :readonly="!editable || saving" /></label
        ><label
          >Effective from (UTC)<input
            v-model="form.effectiveFrom"
            :disabled="saving || selected?.status !== 'APPROVED'"
            type="datetime-local"
          /><small class="field-help"
            >Choose this after approval; it is saved when publishing, in
            UTC.</small
          ></label
        ><label class="wide"
          >Text or content value<textarea
            v-model="form.value"
            :readonly="!editable || saving"
            required
          ></textarea>
        </label>
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
