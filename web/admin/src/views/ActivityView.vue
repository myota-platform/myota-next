<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { apiRequest } from '../lib/api';
import { hasAnyScope } from '../lib/adminAccess';
import PageHeader from '../components/PageHeader.vue';
import PageFeedback from '../components/PageFeedback.vue';
import { usePageFeedback } from '../composables/usePageFeedback';
import { utcDisplay } from '../lib/utc';
import { useAppStore } from '../stores/app';

interface Qso {
  id: string;
  workedCallsign?: string;
  timestamp?: string;
  band?: string;
  mode?: string;
  status?: string;
}

interface Activation {
  id: string;
  programmeSlug?: string;
  entityId?: string;
  operatorId?: string;
  operatorCallsign?: string;
  status?: string;
  qsos?: Qso[];
  qsoCount?: number;
  startedAt?: string;
  endedAt?: string;
  location?: Record<string, unknown>;
  ruleEvaluation?: Record<string, unknown>;
}

interface Statistic {
  id: string;
  programme?: string;
  type?: string;
  scope?: string;
  values?: unknown;
  algorithmVersion?: string;
  generatedAt?: string;
}

interface ActivityNotification {
  id: string;
  type?: string;
  payload?: unknown;
  status?: string;
  createdAt?: string;
  deliveredAt?: string | null;
}

interface ActivityJob {
  jobId?: string;
  id?: string;
  kind?: string;
  status?: string;
  attempts?: number;
  lastError?: string | null;
  completedAt?: string | null;
}

const store = useAppStore();
const feedback = usePageFeedback();
const { error, loading } = feedback;
const items = ref<Activation[]>([]);
const statistics = ref<Statistic[]>([]);
const notifications = ref<ActivityNotification[]>([]);
const notificationPage = ref(1);
const notificationNextPage = ref<number | null>(null);
const notificationTotal = ref(0);
const notificationError = ref('');
const notificationLoading = ref(false);
const selected = ref<Activation | null>(null);
const detailLoading = ref(false);
const detailError = ref('');
const jobLoading = ref(false);
const jobError = ref('');
const job = ref<ActivityJob | null>(null);
const canRead = computed(() =>
  hasAnyScope(store.account, 'activity.read', 'activity.admin'),
);
const canRebuild = computed(() => hasAnyScope(store.account, 'activity.admin'));
const programme = computed(() => store.currentProgramme || '');

function scopedPath(path: string): string {
  if (!programme.value) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}${new URLSearchParams({ programme: programme.value })}`;
}

async function load(): Promise<void> {
  await feedback.run(async () => {
    const [activations, statisticPage] = await Promise.all([
      apiRequest<{ items: Activation[] }>(
        scopedPath('/v1/activations?pageSize=100'),
      ),
      apiRequest<{ items: Statistic[] }>(
        scopedPath('/v1/statistics?pageSize=100'),
      ),
    ]);
    items.value = activations.items || [];
    statistics.value = statisticPage.items || [];
    await loadNotifications(notificationPage.value);
    if (selected.value) {
      const fresh = items.value.find((item) => item.id === selected.value?.id);
      if (!fresh) selected.value = null;
    }
  });
}

async function loadNotifications(page: number): Promise<void> {
  notificationError.value = '';
  notificationLoading.value = true;
  const query = new URLSearchParams({ page: String(page), pageSize: '100' });
  try {
    const result = await apiRequest<{
      items: ActivityNotification[];
      page: number;
      total: number;
      nextPage: number | null;
    }>(`/v1/notifications?${query.toString()}`);
    notifications.value = result.items || [];
    notificationPage.value = result.page || page;
    notificationTotal.value = result.total || 0;
    notificationNextPage.value = result.nextPage ?? null;
  } finally {
    notificationLoading.value = false;
  }
}

async function changeNotificationPage(page: number): Promise<void> {
  if (page < 1) return;
  notificationError.value = '';
  try {
    await loadNotifications(page);
  } catch (cause) {
    notificationError.value =
      cause instanceof Error
        ? cause.message
        : 'Unable to load Activity notifications.';
  }
}

async function openActivation(item: Activation): Promise<void> {
  if (selected.value?.id === item.id) {
    selected.value = null;
    detailError.value = '';
    return;
  }
  selected.value = item;
  detailLoading.value = true;
  detailError.value = '';
  try {
    selected.value = await apiRequest<Activation>(
      `/v1/activations/${encodeURIComponent(item.id)}`,
    );
  } catch (cause) {
    detailError.value =
      cause instanceof Error
        ? cause.message
        : 'Unable to load activation details.';
  } finally {
    detailLoading.value = false;
  }
}

async function rebuildStatistics(): Promise<void> {
  jobLoading.value = true;
  jobError.value = '';
  try {
    const created = await apiRequest<ActivityJob>(
      '/v1/statistics/rebuild-jobs',
      {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ programmeSlug: programme.value || null }),
      },
    );
    job.value = created;
  } catch (cause) {
    jobError.value =
      cause instanceof Error
        ? cause.message
        : 'Unable to queue statistics rebuild.';
  } finally {
    jobLoading.value = false;
  }
}

async function refreshJob(): Promise<void> {
  const id = job.value?.jobId || job.value?.id;
  if (!id) return;
  jobLoading.value = true;
  jobError.value = '';
  try {
    job.value = await apiRequest<ActivityJob>(
      `/v1/statistics/rebuild-jobs/${encodeURIComponent(id)}`,
    );
    if (['SUCCEEDED', 'FAILED'].includes(job.value.status || '')) await load();
  } catch (cause) {
    jobError.value =
      cause instanceof Error
        ? cause.message
        : 'Unable to refresh rebuild status.';
  } finally {
    jobLoading.value = false;
  }
}

function formatValues(values: unknown): string {
  return JSON.stringify(values ?? {});
}

onMounted(() => {
  if (canRead.value) void load();
});
watch(programme, () => {
  if (canRead.value) void load();
});
</script>

<template>
  <PageHeader :refresh="load" :busy="loading" />
  <PageFeedback :error="error" :loading="loading" />

  <article v-if="canRebuild" class="panel">
    <div class="panel-heading">
      <div>
        <h2>Statistics maintenance</h2>
        <p class="muted">
          Queue a versioned rebuild for {{ programme || 'all programmes' }}.
        </p>
      </div>
      <button class="primary" :disabled="jobLoading" @click="rebuildStatistics">
        {{ jobLoading ? 'Working…' : 'Rebuild statistics' }}
      </button>
    </div>
    <div v-if="job" class="activity-job">
      <span><strong>Job</strong> {{ job.jobId || job.id }}</span>
      <span class="status-pill" :class="(job.status || '').toLowerCase()">
        {{ job.status || 'QUEUED' }}
      </span>
      <span>{{ job.attempts ?? 0 }} attempts</span>
      <button class="secondary" :disabled="jobLoading" @click="refreshJob">
        Refresh status
      </button>
      <p v-if="job.lastError" class="error-text">{{ job.lastError }}</p>
    </div>
    <p v-if="jobError" class="error-text" role="alert">{{ jobError }}</p>
  </article>

  <article class="panel">
    <div class="panel-heading">
      <h2>Activation history</h2>
      <span class="muted">{{ items.length }} loaded</span>
    </div>
    <div class="table-list">
      <button
        v-for="item in items"
        :key="item.id"
        class="table-row activity-row"
        :class="{ selected: selected?.id === item.id }"
        :aria-expanded="selected?.id === item.id"
        @click="openActivation(item)"
      >
        <span>
          <strong>{{
            item.operatorCallsign || item.operatorId || 'Unknown operator'
          }}</strong>
          <small
            >{{ item.programmeSlug || 'Unassigned' }} ·
            {{ item.entityId || 'No entity' }}</small
          >
          <small>
            {{ item.startedAt ? utcDisplay(item.startedAt) : 'Not started' }}
            <span v-if="item.endedAt"> → {{ utcDisplay(item.endedAt) }}</span>
          </small>
        </span>
        <span class="status-pill" :class="(item.status || '').toLowerCase()">{{
          item.status
        }}</span>
        <span>{{ item.qsoCount ?? '—' }} QSOs</span>
      </button>
      <p v-if="!items.length && !loading" class="muted empty">
        No activations recorded.
      </p>
    </div>
    <section v-if="selected" class="activity-detail" aria-live="polite">
      <p v-if="detailLoading" class="muted">Loading activation details…</p>
      <p v-else-if="detailError" class="error-text" role="alert">
        {{ detailError }}
      </p>
      <template v-else>
        <div class="panel-heading">
          <h3>QSOs ({{ selected.qsos?.length || 0 }})</h3>
          <span class="muted">{{ selected.id }}</span>
        </div>
        <div class="table-list">
          <div
            v-for="qso in selected.qsos || []"
            :key="qso.id"
            class="table-row"
          >
            <span>
              <strong>{{ qso.workedCallsign || 'Unknown callsign' }}</strong>
              <small>{{
                qso.timestamp ? utcDisplay(qso.timestamp) : 'Time unavailable'
              }}</small>
            </span>
            <span>{{
              [qso.band, qso.mode].filter(Boolean).join(' · ') || '—'
            }}</span>
            <span
              class="status-pill"
              :class="(qso.status || '').toLowerCase()"
              >{{ qso.status }}</span
            >
          </div>
          <p v-if="!selected.qsos?.length" class="muted empty">
            No QSOs recorded.
          </p>
        </div>
      </template>
    </section>
  </article>

  <article class="panel">
    <div class="panel-heading">
      <div>
        <h2>Statistics snapshots</h2>
        <p class="muted">
          Precomputed Activity statistics for
          {{ programme || 'all programmes' }}.
        </p>
      </div>
      <span class="muted">{{ statistics.length }} loaded</span>
    </div>
    <div class="table-list">
      <div
        v-for="item in statistics"
        :key="item.id"
        class="table-row statistic-row"
      >
        <span>
          <strong
            >{{ item.type || 'Statistic' }} ·
            {{ item.scope || 'all scope' }}</strong
          >
          <small
            >{{ item.programme || 'Unknown programme' }} · algorithm
            {{ item.algorithmVersion || '—' }}</small
          >
          <small>{{
            item.generatedAt
              ? utcDisplay(item.generatedAt)
              : 'Generation time unavailable'
          }}</small>
          <code>{{ formatValues(item.values) }}</code>
        </span>
      </div>
      <p v-if="!statistics.length && !loading" class="muted empty">
        No statistics snapshots available.
      </p>
    </div>
  </article>

  <article class="panel">
    <div class="panel-heading">
      <div>
        <h2>My Activity notifications</h2>
        <p class="muted">Notification records addressed to your account.</p>
      </div>
      <span class="muted"
        >{{ notifications.length }} of {{ notificationTotal }} loaded · page
        {{ notificationPage }}</span
      >
    </div>
    <div class="table-list">
      <div
        v-for="item in notifications"
        :key="item.id"
        class="table-row statistic-row"
      >
        <span>
          <strong>{{ item.type || 'Activity notification' }}</strong>
          <small>{{
            item.createdAt ? utcDisplay(item.createdAt) : 'Time unavailable'
          }}</small>
          <code>{{ formatValues(item.payload) }}</code>
        </span>
        <span class="status-pill" :class="(item.status || '').toLowerCase()">
          {{ item.status || 'UNKNOWN' }}
        </span>
      </div>
      <p v-if="!notifications.length && !loading" class="muted empty">
        No Activity notifications for this account.
      </p>
    </div>
    <div class="toolbar notification-pagination">
      <p v-if="notificationError" class="error-text" role="alert">
        {{ notificationError }}
      </p>
      <button
        class="secondary"
        :disabled="notificationPage <= 1 || notificationLoading"
        @click="changeNotificationPage(notificationPage - 1)"
      >
        Previous
      </button>
      <button
        class="secondary"
        :disabled="notificationNextPage === null || notificationLoading"
        @click="
          changeNotificationPage(notificationNextPage || notificationPage)
        "
      >
        Next
      </button>
    </div>
  </article>
</template>
