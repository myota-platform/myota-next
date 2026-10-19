<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { apiRequest } from '../lib/api';
import PageHeader from '../components/PageHeader.vue';
import PageFeedback from '../components/PageFeedback.vue';
import { usePageFeedback } from '../composables/usePageFeedback';
import { utcDisplay } from '../lib/utc';
interface Activation {
  id: string;
  programmeSlug?: string;
  entityId?: string;
  operatorId?: string;
  status?: string;
  qsos?: unknown[];
  qsoCount?: number;
  startedAt?: string;
  closedAt?: string;
}
const items = ref<Activation[]>([]);
const feedback = usePageFeedback();
const { error, loading } = feedback;
async function load(): Promise<void> {
  await feedback.run(async () => {
    const data = await apiRequest<{ items: Activation[] }>(
      '/v1/activations?pageSize=100',
    );
    items.value = data.items || [];
  });
}
onMounted(load);
</script>

<template>
  <PageHeader :refresh="load" :busy="loading" /><PageFeedback
    :error="error"
    :loading="loading"
  />
  <article class="panel">
    <div class="panel-heading">
      <h2>Activations</h2>
      <span class="muted">{{ items.length }} loaded</span>
    </div>
    <div class="table-list">
      <div v-for="item in items" :key="item.id" class="table-row">
        <span
          ><strong>{{ item.id.slice(0, 8) }}…</strong
          ><small
            >{{ item.programmeSlug || 'Unassigned' }} · {{ item.entityId }} ·
            {{ item.operatorId }}</small
          ><small
            >{{ item.startedAt ? utcDisplay(item.startedAt) : 'Not started'
            }}<span v-if="item.closedAt">
              → {{ utcDisplay(item.closedAt) }}</span
            ></small
          ></span
        ><span
          class="status-pill"
          :class="item.status === 'OPEN' ? 'proposed' : 'approved'"
          >{{ item.status }}</span
        ><span>{{ item.qsoCount ?? item.qsos?.length ?? '—' }} QSOs</span>
      </div>
      <p v-if="!items.length" class="muted empty">No activations recorded.</p>
    </div>
  </article>
</template>
