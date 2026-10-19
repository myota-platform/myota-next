<script setup lang="ts">
defineProps<{
  error?: string;
  message?: string;
  loading?: boolean;
  loadingLabel?: string;
}>();
</script>
<template>
  <div v-if="error" class="error-card page-feedback" role="alert">
    {{ error }}
  </div>
  <div v-if="message" class="notice page-feedback" role="status">
    {{ message }}
  </div>
  <p v-if="loading" class="loading-card page-feedback" role="status">
    {{ loadingLabel || 'Loading records…' }}
  </p>
</template>
