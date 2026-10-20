<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import PageFeedback from '../components/PageFeedback.vue';
import PageHeader from '../components/PageHeader.vue';
import PageNavigation from '../components/PageNavigation.vue';
import { usePageFeedback } from '../composables/usePageFeedback';
import { apiRequest } from '../lib/api';
import { myotaClient } from '../lib/myotaClient';
import { utcDisplay } from '../lib/utc';
import { useAppStore } from '../stores/app';

interface EntitySummary {
  id: string;
  name?: string;
  status?: string;
  geometry?: unknown;
}

interface ResolutionEntry {
  decision?: string;
  previousDecision?: string;
  reviewerId?: string;
  note?: string | null;
  occurredAt?: string;
}

interface ConflationCandidate {
  id: string;
  leftEntityId: string;
  rightEntityId: string;
  leftEntity?: EntitySummary;
  rightEntity?: EntitySummary;
  score?: number;
  signals?: unknown;
  resolution?: string;
  resolutionHistory?: ResolutionEntry[];
  survivorEntityId?: string | null;
}

const store = useAppStore();
const feedback = usePageFeedback();
const { error, loading } = feedback;
const reviewerId = computed(() => store.account?.id || '');
const items = ref<ConflationCandidate[]>([]);
const page = ref(1);
const pageSize = 50;
const total = ref(0);
const nextPage = ref<number | null>(null);
const resolution = ref('OPEN');
const busyId = ref('');
const message = ref('');
const resolveError = ref('');
const decisions = reactive<Record<string, string>>({});
const survivors = reactive<Record<string, string>>({});
const notes = reactive<Record<string, string>>({});

async function load(targetPage = page.value): Promise<void> {
  await feedback.run(async () => {
    const query = new URLSearchParams({
      resolution: resolution.value,
      page: String(targetPage),
      pageSize: String(pageSize),
    });
    const data = await apiRequest<{
      items: ConflationCandidate[];
      page: number;
      total: number;
      nextPage: number | null;
    }>(`/v1/geodata/conflation?${query.toString()}`);
    items.value = data.items || [];
    page.value = data.page || targetPage;
    total.value = data.total || 0;
    nextPage.value = data.nextPage ?? null;
    for (const item of items.value) {
      decisions[item.id] = item.resolution || 'OPEN';
      survivors[item.id] = item.survivorEntityId || '';
      notes[item.id] = '';
    }
    resolveError.value = '';
  });
}

async function resolve(item: ConflationCandidate): Promise<void> {
  if (!reviewerId.value) {
    resolveError.value = 'The signed-in account is unavailable.';
    return;
  }
  busyId.value = item.id;
  message.value = '';
  resolveError.value = '';
  try {
    await myotaClient.resolveGeodataConflation(item.id, {
      decision: decisions[item.id] || 'OPEN',
      reviewerId: reviewerId.value,
      survivorEntityId: survivors[item.id] || undefined,
      note: notes[item.id] || undefined,
    });
    message.value = `Resolution recorded for ${item.id}.`;
    await load();
  } catch (cause) {
    resolveError.value =
      cause instanceof Error ? cause.message : 'Unable to resolve candidate.';
  } finally {
    busyId.value = '';
  }
}

function formatSignals(signals: unknown): string {
  return JSON.stringify(signals ?? {});
}

onMounted(() => void load(1));
watch(resolution, () => {
  message.value = '';
  void load(1);
});
</script>

<template>
  <PageHeader :refresh="load" :busy="loading">
    <label class="toolbar-field">
      Resolution
      <select v-model="resolution" :disabled="loading">
        <option value="OPEN">Open</option>
        <option value="MERGED">Merged</option>
        <option value="KEPT_SEPARATE">Kept separate</option>
        <option value="IGNORED">Ignored</option>
      </select>
    </label>
  </PageHeader>
  <PageFeedback :error="error" :loading="loading" />
  <p v-if="message" class="success-text" role="status">{{ message }}</p>
  <p v-if="resolveError" class="error-text" role="alert">
    {{ resolveError }}
  </p>

  <article class="panel">
    <div class="panel-heading">
      <div>
        <h2>Potentially matching entities</h2>
        <p class="muted">
          Compare entity details and match signals before recording a decision.
        </p>
      </div>
      <span class="muted">{{ total }} candidates</span>
    </div>

    <div class="conflation-list">
      <section v-for="item in items" :key="item.id" class="conflation-card">
        <div class="conflation-pair">
          <div>
            <strong>{{ item.leftEntity?.name || item.leftEntityId }}</strong>
            <small>{{ item.leftEntity?.status || 'Unknown status' }}</small>
            <code>{{ item.leftEntityId }}</code>
          </div>
          <span class="conflation-score">
            {{
              typeof item.score === 'number'
                ? `${(item.score * 100).toFixed(1)}%`
                : '—'
            }}
          </span>
          <div>
            <strong>{{ item.rightEntity?.name || item.rightEntityId }}</strong>
            <small>{{ item.rightEntity?.status || 'Unknown status' }}</small>
            <code>{{ item.rightEntityId }}</code>
          </div>
        </div>

        <details class="conflation-signals">
          <summary>Match signals and resolution history</summary>
          <code>{{
            formatSignals({
              signals: item.signals,
              leftGeometry: item.leftEntity?.geometry,
              rightGeometry: item.rightEntity?.geometry,
            })
          }}</code>
          <ul v-if="item.resolutionHistory?.length">
            <li v-for="(entry, index) in item.resolutionHistory" :key="index">
              {{ entry.decision }} by
              {{ entry.reviewerId || 'unknown reviewer' }}
              <span v-if="entry.occurredAt">
                · {{ utcDisplay(entry.occurredAt) }}</span
              >
              <span v-if="entry.note"> · {{ entry.note }}</span>
            </li>
          </ul>
        </details>

        <div class="conflation-controls">
          <label>
            Decision
            <select v-model="decisions[item.id]">
              <option value="MERGED">Merged</option>
              <option value="KEPT_SEPARATE">Keep separate</option>
              <option value="IGNORED">Ignore</option>
              <option value="OPEN">Reopen</option>
            </select>
          </label>
          <label>
            Surviving entity (optional)
            <select v-model="survivors[item.id]">
              <option value="">No survivor selected</option>
              <option :value="item.leftEntityId">
                {{ item.leftEntity?.name || item.leftEntityId }}
              </option>
              <option :value="item.rightEntityId">
                {{ item.rightEntity?.name || item.rightEntityId }}
              </option>
            </select>
          </label>
          <label class="conflation-note">
            Review note
            <input v-model="notes[item.id]" maxlength="2000" />
          </label>
          <button
            class="primary"
            :disabled="busyId === item.id"
            @click="resolve(item)"
          >
            {{ busyId === item.id ? 'Saving…' : 'Record decision' }}
          </button>
        </div>
      </section>
      <p v-if="!items.length && !loading" class="muted empty">
        No {{ resolution === 'OPEN' ? 'open ' : '' }}conflation candidates.
      </p>
    </div>

    <PageNavigation
      class="conflation-pagination"
      :page="page"
      :next-page="nextPage"
      :total="total"
      count-label="candidates"
      :busy="loading"
      label="conflation candidates"
      @change="load"
    />
  </article>
</template>
