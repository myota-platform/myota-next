<script setup lang="ts">
withDefaults(
  defineProps<{
    page: number;
    nextPage: number | null;
    label: string;
    total?: number;
    countLabel?: string;
    busy?: boolean;
    showSummary?: boolean;
    previousLabel?: string;
    nextLabel?: string;
  }>(),
  {
    busy: false,
    showSummary: true,
    previousLabel: 'Previous',
    nextLabel: 'Next',
  },
);

const emit = defineEmits<{ change: [page: number] }>();
</script>

<template>
  <nav class="toolbar pagination-controls" :aria-label="`${label} pages`">
    <button
      class="secondary"
      :disabled="busy || page <= 1"
      :aria-label="
        previousLabel === 'Previous'
          ? `Previous page of ${label}`
          : previousLabel
      "
      @click="emit('change', page - 1)"
    >
      {{ previousLabel }}
    </button>
    <span v-if="showSummary && total !== undefined" aria-live="polite">
      Page {{ page }} · {{ total }} {{ countLabel || label }}
    </span>
    <button
      class="secondary"
      :disabled="busy || nextPage === null"
      :aria-label="nextLabel === 'Next' ? `Next page of ${label}` : nextLabel"
      @click="emit('change', nextPage ?? page)"
    >
      {{ nextLabel }}
    </button>
  </nav>
</template>
