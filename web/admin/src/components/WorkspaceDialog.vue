<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';

const props = defineProps<{
  open: boolean;
  title: string;
  eyebrow?: string;
  compact?: boolean;
}>();
const emit = defineEmits<{ 'request-close': [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
const titleId = useId();

// showModal supplies focus containment, Escape handling and an inert background.
// Leave close decisions to the owner so unsaved edits can be protected.
watch(
  () => props.open,
  async (open) => {
    await nextTick();
    if (open && !dialog.value?.open) dialog.value?.showModal();
    else if (!open && dialog.value?.open) dialog.value.close();
  },
  { immediate: true, flush: 'post' },
);

onBeforeUnmount(() => dialog.value?.close());
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="workspace-dialog"
      :class="{ 'workspace-dialog-compact': compact }"
      :aria-labelledby="titleId"
      @cancel.prevent="emit('request-close')"
    >
      <header class="workspace-dialog-header">
        <div>
          <p v-if="eyebrow" class="eyebrow">{{ eyebrow }}</p>
          <h2 :id="titleId">{{ title }}</h2>
        </div>
        <button
          type="button"
          class="secondary"
          autofocus
          @click="emit('request-close')"
        >
          Close
        </button>
      </header>
      <div class="workspace-dialog-content"><slot /></div>
    </dialog>
  </Teleport>
</template>
