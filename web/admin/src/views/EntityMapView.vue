<script setup lang="ts">
import PageHeader from '../components/PageHeader.vue';
import { onBeforeUnmount, ref } from 'vue';
import { apiRequest } from '../lib/api';
import LeafletMap from '../components/LeafletMap.vue';
import type { GeoEntity } from '../types';

const entities = ref<GeoEntity[]>([]);
const selected = ref<GeoEntity | null>(null);
const loading = ref(false);
const error = ref('');
const total = ref(0);
const capReached = ref(false);
const limit = 500;
const viewport = ref<{
  bbox: [number, number, number, number];
  zoom: number;
} | null>(null);
let viewportTimer: number | undefined;
let requestSequence = 0;
async function loadViewport(): Promise<void> {
  const current = viewport.value;
  if (!current) return;
  const sequence = ++requestSequence;
  loading.value = true;
  error.value = '';
  try {
    const params = new URLSearchParams({
      bbox: current.bbox.join(','),
      zoom: String(current.zoom),
    });
    const data = await apiRequest<{
      items: GeoEntity[];
      total: number;
      limit: number;
      truncated: boolean;
    }>(`/v1/geodata/map/entities?${params}`);
    if (sequence !== requestSequence) return;
    entities.value = (data.items || []).slice(0, limit);
    total.value = Number(data.total || 0);
    capReached.value = data.truncated === true || total.value >= limit;
    if (selected.value)
      selected.value =
        entities.value.find((item) => item.id === selected.value?.id) || null;
  } catch (e) {
    if (sequence !== requestSequence) return;
    error.value = e instanceof Error ? e.message : 'Unable to load entities.';
  } finally {
    if (sequence === requestSequence) loading.value = false;
  }
}
function updateViewport(next: {
  bbox: [number, number, number, number];
  zoom: number;
}): void {
  viewport.value = next;
  if (viewportTimer !== undefined) window.clearTimeout(viewportTimer);
  viewportTimer = window.setTimeout(() => {
    viewportTimer = undefined;
    void loadViewport();
  }, 120);
}
function refreshViewport(): void {
  if (viewport.value) void loadViewport();
}
onBeforeUnmount(() => {
  requestSequence += 1;
  if (viewportTimer !== undefined) window.clearTimeout(viewportTimer);
});
function select(entity: GeoEntity): void {
  selected.value = entity;
}
function categories(entity: GeoEntity): string {
  return (
    (entity.entityTypes || (entity.entityType ? [entity.entityType] : []))
      .map((item) => (typeof item === 'string' ? item : item.code))
      .join(', ') || '—'
  );
}
function programmes(entity: GeoEntity): string {
  return (
    (entity.programmes || [])
      .map((item) => (typeof item === 'string' ? item : item.name || item.slug))
      .join(', ') || 'Unassigned'
  );
}
</script>

<template>
  <PageHeader :refresh="refreshViewport" :busy="loading" />
  <div v-if="error" class="error-card" role="alert">{{ error }}</div>
  <article class="panel map-panel">
    <div class="panel-heading">
      <h2>
        {{
          loading
            ? 'Loading…'
            : `${entities.length} of ${total} entities in this view`
        }}
      </h2>
      <p v-if="capReached" class="notice" role="status" aria-live="polite">
        The 500-entity map limit is reached. Zoom in to see entities in a
        smaller area.
      </p>
    </div>
    <LeafletMap
      :entities="entities"
      :selected-id="selected?.id"
      height="760px"
      :viewport-managed="true"
      geometry-simplification="server"
      :initial-view="{ center: [20, 0], zoom: 2 }"
      @select="select"
      @viewport-change="updateViewport"
    ></LeafletMap>
    <details class="entity-map-directory">
      <summary>Browse loaded entities by name ({{ entities.length }})</summary>
      <ul>
        <li v-for="entity in entities" :key="entity.id">
          <button
            type="button"
            :aria-pressed="selected?.id === entity.id"
            @click="select(entity)"
          >
            <strong>{{ entity.name }}</strong>
            <span>{{ entity.status }} · {{ categories(entity) }}</span>
          </button>
        </li>
      </ul>
    </details>
  </article>
  <article v-if="selected" class="panel selected-entity">
    <div class="panel-heading">
      <div>
        <p class="eyebrow">SELECTED ENTITY</p>
        <h2>{{ selected.name }}</h2>
      </div>
      <span class="status-pill" :class="selected.status.toLowerCase()">{{
        selected.status
      }}</span>
    </div>
    <div class="info-grid">
      <div>
        <span>Category</span><strong>{{ categories(selected) }}</strong>
      </div>
      <div>
        <span>Programmes</span><strong>{{ programmes(selected) }}</strong>
      </div>
      <div>
        <span>Continent</span
        ><strong>{{ selected.location?.continent || '—' }}</strong>
      </div>
      <div>
        <span>Country</span
        ><strong>{{ selected.location?.country || '—' }}</strong>
      </div>
      <div>
        <span>Region</span
        ><strong>{{ selected.location?.region || '—' }}</strong>
      </div>
      <div>
        <span>City</span><strong>{{ selected.location?.city || '—' }}</strong>
      </div>
    </div>
  </article>
</template>
