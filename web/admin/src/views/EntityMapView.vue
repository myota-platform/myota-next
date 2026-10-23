<script setup lang="ts">
import PageHeader from '../components/PageHeader.vue';
import { onMounted, ref } from 'vue';
import { apiRequest } from '../lib/api';
import LeafletMap from '../components/LeafletMap.vue';
import type { GeoEntity } from '../types';

const entities = ref<GeoEntity[]>([]);
const selected = ref<GeoEntity | null>(null);
const loading = ref(false);
const error = ref('');
const total = ref(0);
const page = ref(1);
async function load(more = false): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  error.value = '';
  const next = more ? page.value + 1 : 1;
  try {
    const data = await apiRequest<{ items: GeoEntity[]; total?: number }>(
      `/v1/geodata/entities?page=${next}&pageSize=100`,
    );
    entities.value = more
      ? [...entities.value, ...(data.items || [])]
      : data.items || [];
    total.value = data.total ?? entities.value.length;
    page.value = next;
    if (selected.value)
      selected.value =
        entities.value.find((item) => item.id === selected.value?.id) || null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Unable to load entities.';
  } finally {
    loading.value = false;
  }
}
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
onMounted(() => load());
</script>

<template>
  <PageHeader :refresh="() => load()" :busy="loading" />
  <div v-if="error" class="error-card" role="alert">{{ error }}</div>
  <article class="panel map-panel">
    <div class="panel-heading">
      <h2>
        {{
          loading
            ? 'Loading…'
            : `${entities.length} of ${total} entities loaded`
        }}
      </h2>
      <button
        v-if="entities.length < total"
        class="secondary"
        :disabled="loading"
        @click="load(true)"
      >
        Load next 100
      </button>
    </div>
    <LeafletMap
      :entities="entities"
      :selected-id="selected?.id"
      height="760px"
      @select="select"
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
