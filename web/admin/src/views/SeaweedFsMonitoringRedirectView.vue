<script setup lang="ts">
import { onMounted } from 'vue';

const dashboardPath = '/observability/d/myota-object-storage';

onMounted(() => {
  window.location.replace(dashboardPath);
});
</script>

<template>
  <section class="panel">
    <h1>SeaweedFS monitoring moved</h1>
    <p>
      Storage monitoring is now provided by the provisioned Grafana dashboard.
    </p>
    <a class="link-button" :href="dashboardPath">
      Open the SeaweedFS dashboard in Grafana
    </a>
  </section>
</template>
