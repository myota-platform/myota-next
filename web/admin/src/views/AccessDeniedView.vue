<script setup lang="ts">
import PageHeader from '../components/PageHeader.vue';
</script>
<template>
  <PageHeader
    title="Access not available"
    description="You are signed in, but your current permissions do not include this workspace."
  />
  <article class="panel">
    <h2>Choose an available workspace</h2>
    <p class="muted">
      Use the navigation or return to Overview. An administrator can assign the
      required access; signing in again will not add permissions.
    </p>
    <RouterLink class="link-button" to="/dashboard"
      >Return to Overview</RouterLink
    >
  </article>
</template>
