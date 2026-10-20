<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import PageFeedback from '../components/PageFeedback.vue';
import PageHeader from '../components/PageHeader.vue';
import { usePageFeedback } from '../composables/usePageFeedback';
import { apiRequest } from '../lib/api';
import { myotaClient } from '../lib/myotaClient';
import { utcDisplay } from '../lib/utc';
import { useAppStore } from '../stores/app';
import type { EntityCategory } from '../types';

interface RefreshSchedule {
  id: string;
  programmeSlug?: string | null;
  entityType?: string;
  entityTypes?: string[];
  adapter: string;
  source: Record<string, unknown>;
  intervalSeconds: number;
  disappearancePolicy: string;
  enabled: boolean;
  lastRunAt?: string | null;
  nextRunAt?: string;
  createdAt?: string;
}

const store = useAppStore();
const feedback = usePageFeedback();
const { error, loading } = feedback;
const schedules = ref<RefreshSchedule[]>([]);
const categories = ref<EntityCategory[]>([]);
const offset = ref(0);
const total = ref(0);
const pageSize = 100;
const saving = ref(false);
const runningId = ref('');
const message = ref('');
const actionError = ref('');
const snapshotFile = ref<File | null>(null);
const scheduleForm = reactive({
  programmeSlug: '',
  adapter: 'MANUAL',
  entityTypes: [] as string[],
  source: '{\n  "name": "Manual source"\n}',
  intervalSeconds: 86400,
  disappearancePolicy: 'REVIEW_REQUIRED',
});

async function load(requestedOffset = offset.value): Promise<void> {
  await feedback.run(async () => {
    const [page, categoryPage] = await Promise.all([
      apiRequest<{
        items: RefreshSchedule[];
        page: number;
        pageSize: number;
        total: number;
        nextPage: number | null;
      }>(
        `/v1/geodata/refresh-schedules?page=${Math.floor(requestedOffset / pageSize) + 1}&pageSize=${pageSize}`,
      ),
      apiRequest<{ items: EntityCategory[] }>('/v1/entity-types'),
    ]);
    schedules.value = page.items || [];
    total.value = page.total || 0;
    offset.value = (page.page - 1) * page.pageSize;
    categories.value = categoryPage.items || [];
  });
}

async function createSchedule(): Promise<void> {
  actionError.value = '';
  message.value = '';
  let source: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(scheduleForm.source);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Source settings must be a JSON object.');
    source = parsed as Record<string, unknown>;
  } catch (cause) {
    actionError.value =
      cause instanceof Error ? cause.message : 'Invalid source settings JSON.';
    return;
  }
  if (!scheduleForm.entityTypes.length) {
    actionError.value = 'Choose at least one entity category.';
    return;
  }
  saving.value = true;
  try {
    await myotaClient.createGeodataRefreshSchedule({
      programmeSlug: scheduleForm.programmeSlug || null,
      adapter: scheduleForm.adapter,
      entityTypes: scheduleForm.entityTypes,
      source,
      intervalSeconds: scheduleForm.intervalSeconds,
      disappearancePolicy: scheduleForm.disappearancePolicy,
    });
    message.value = 'Refresh schedule created.';
    offset.value = 0;
    await load(0);
  } catch (cause) {
    actionError.value =
      cause instanceof Error ? cause.message : 'Unable to create schedule.';
  } finally {
    saving.value = false;
  }
}

function chooseSnapshot(event: Event): void {
  snapshotFile.value = (event.target as HTMLInputElement).files?.[0] || null;
  message.value = '';
  actionError.value = '';
}

async function runSchedule(schedule: RefreshSchedule): Promise<void> {
  const file = snapshotFile.value;
  if (!file) {
    actionError.value =
      'Choose a GeoJSON snapshot before running the schedule.';
    return;
  }
  actionError.value = '';
  message.value = '';
  runningId.value = schedule.id;
  try {
    const parsed: unknown = JSON.parse(await file.text());
    const features = Array.isArray(parsed)
      ? parsed
      : parsed &&
          typeof parsed === 'object' &&
          'features' in parsed &&
          Array.isArray(parsed.features)
        ? parsed.features
        : null;
    if (!features)
      throw new Error('The file must contain a GeoJSON FeatureCollection.');
    const result = await myotaClient.runGeodataRefreshSchedule(schedule.id, {
      features,
    });
    message.value = `Snapshot queued for ${schedule.id}.`;
    await load();
    if (result && typeof result === 'object' && 'id' in result)
      message.value += ` Import ${String(result.id)}.`;
  } catch (cause) {
    actionError.value =
      cause instanceof Error ? cause.message : 'Unable to queue snapshot.';
  } finally {
    runningId.value = '';
  }
}

function previousPage(): void {
  if (offset.value <= 0) return;
  void load(Math.max(0, offset.value - pageSize));
}

function nextPage(): void {
  if (offset.value + schedules.value.length >= total.value) return;
  void load(offset.value + pageSize);
}

function formatEntityTypes(schedule: RefreshSchedule): string {
  return (schedule.entityTypes || [schedule.entityType || '']).join(', ');
}

onMounted(() => void load(0));
</script>

<template>
  <PageHeader :refresh="() => load()" :busy="loading" />
  <PageFeedback :error="error" :loading="loading" />
  <p v-if="message" class="success-text" role="status">{{ message }}</p>
  <p v-if="actionError" class="error-text" role="alert">{{ actionError }}</p>

  <article class="panel">
    <div class="panel-heading">
      <div>
        <h2>Create a refresh schedule</h2>
        <p class="muted">
          A schedule applies disappearance policy only after a complete snapshot
          is promoted successfully.
        </p>
      </div>
    </div>
    <div class="schedule-form">
      <label>
        Programme
        <select v-model="scheduleForm.programmeSlug">
          <option value="">All programmes</option>
          <option
            v-for="item in store.programmes"
            :key="item.slug"
            :value="item.slug"
          >
            {{ item.name }}
          </option>
        </select>
      </label>
      <label>
        Adapter
        <select v-model="scheduleForm.adapter">
          <option value="MANUAL">Manual</option>
          <option value="PARKSERVE_US">ParkServe US</option>
          <option value="OSM">OpenStreetMap</option>
          <option value="GOVERNMENT_GIS">Government GIS</option>
        </select>
      </label>
      <label>
        Interval (seconds)
        <input
          v-model.number="scheduleForm.intervalSeconds"
          type="number"
          min="300"
          step="60"
        />
      </label>
      <label>
        Disappearance policy
        <select v-model="scheduleForm.disappearancePolicy">
          <option value="REVIEW_REQUIRED">Review required</option>
          <option value="UNCHANGED">Leave unchanged</option>
          <option value="STALE">Mark stale</option>
          <option value="RETIRED">Retire</option>
        </select>
      </label>
      <fieldset class="schedule-categories">
        <legend>Entity categories</legend>
        <label v-for="category in categories" :key="category.code">
          <input
            v-model="scheduleForm.entityTypes"
            type="checkbox"
            :value="category.code"
          />
          {{ category.label || category.code }}
        </label>
      </fieldset>
      <label class="schedule-source">
        Source settings (JSON object)
        <textarea v-model="scheduleForm.source" rows="5" spellcheck="false" />
      </label>
      <button class="primary" :disabled="saving" @click="createSchedule">
        {{ saving ? 'Creating…' : 'Create schedule' }}
      </button>
    </div>
  </article>

  <article class="panel">
    <div class="panel-heading">
      <div>
        <h2>Schedules</h2>
        <p class="muted">{{ total }} schedules · page size {{ pageSize }}</p>
      </div>
    </div>
    <label class="snapshot-picker">
      Manual complete snapshot (GeoJSON)
      <input
        type="file"
        accept=".json,.geojson,application/geo+json,application/json"
        @change="chooseSnapshot"
      />
    </label>
    <p v-if="snapshotFile" class="field-help">
      Selected: {{ snapshotFile.name }}
    </p>
    <div class="table-list schedule-list">
      <section
        v-for="schedule in schedules"
        :key="schedule.id"
        class="schedule-row"
      >
        <div class="schedule-summary">
          <strong
            >{{ schedule.adapter }} · {{ formatEntityTypes(schedule) }}</strong
          >
          <small
            >{{ schedule.programmeSlug || 'All programmes' }} · every
            {{ schedule.intervalSeconds }} seconds</small
          >
          <small
            >Disappearance: {{ schedule.disappearancePolicy }} ·
            {{ schedule.enabled ? 'enabled' : 'disabled' }}</small
          >
          <small
            >Last run:
            {{
              schedule.lastRunAt ? utcDisplay(schedule.lastRunAt) : 'Never'
            }}</small
          >
          <small
            >Next run:
            {{
              schedule.nextRunAt
                ? utcDisplay(schedule.nextRunAt)
                : 'Not scheduled'
            }}</small
          >
          <code>{{ schedule.id }} · {{ JSON.stringify(schedule.source) }}</code>
        </div>
        <button
          class="secondary"
          :disabled="
            !schedule.enabled || runningId === schedule.id || !snapshotFile
          "
          @click="runSchedule(schedule)"
        >
          {{ runningId === schedule.id ? 'Queueing…' : 'Run with snapshot' }}
        </button>
      </section>
      <p v-if="!schedules.length && !loading" class="muted empty">
        No refresh schedules have been created.
      </p>
    </div>
    <div class="toolbar schedule-pagination">
      <button
        class="secondary"
        :disabled="offset === 0 || loading"
        @click="previousPage"
      >
        Previous
      </button>
      <button
        class="secondary"
        :disabled="offset + schedules.length >= total || loading"
        @click="nextPage"
      >
        Next
      </button>
    </div>
  </article>
</template>
