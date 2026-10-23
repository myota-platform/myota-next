<script setup lang="ts">
import { useAppStore } from '../stores/app';
defineProps<{ modelValue: string; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const store = useAppStore();
</script>
<template>
  <div class="programme-scope panel">
    <label class="toolbar-field"
      >Programme<select
        aria-label="Programme"
        :value="modelValue"
        :disabled="disabled"
        @change="
          emit('update:modelValue', ($event.target as HTMLSelectElement).value)
        "
      >
        <option value="" disabled>Choose a programme</option>
        <option
          v-for="programme in store.programmes"
          :key="programme.slug"
          :value="programme.slug"
        >
          {{ programme.name }}
        </option>
      </select></label
    >
    <p class="field-help">
      Applies to this workspace. Each programme owns its configuration; entity
      imports and shared categories stay platform-wide.
    </p>
  </div>
</template>
