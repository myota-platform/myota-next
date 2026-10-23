<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { pageFor } from '../lib/adminNavigation';
import PageFeedback from './PageFeedback.vue';
const props = defineProps<{
  title?: string;
  description?: string;
  refresh?: () => unknown | Promise<unknown>;
  busy?: boolean;
}>();
const route = useRoute();
const page = computed(() => pageFor(route.path));
const refreshing = ref(false);
const error = ref('');
async function refresh(): Promise<void> {
  if (!props.refresh || refreshing.value || props.busy) return;
  refreshing.value = true;
  error.value = '';
  try {
    await props.refresh();
  } catch (cause) {
    error.value =
      cause instanceof Error
        ? cause.message
        : 'Unable to refresh. Your previous results remain visible.';
  } finally {
    refreshing.value = false;
  }
}
</script>
<template>
  <section class="page-heading">
    <div>
      <p class="eyebrow">{{ page?.group || 'Administration' }}</p>
      <h1>{{ title || page?.title || 'Administration' }}</h1>
      <p class="muted page-description">
        {{ description || page?.description }}
      </p>
    </div>
    <div class="page-actions">
      <button
        v-if="props.refresh"
        class="secondary"
        :disabled="refreshing || busy"
        @click="refresh"
      >
        {{ refreshing ? 'Refreshing…' : 'Refresh' }}</button
      ><slot />
    </div>
  </section>
  <PageFeedback :error="error" />
</template>
