<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppShell from './components/AppShell.vue';

const route = useRoute();
const router = useRouter();
const loading = ref(true);

onMounted(async () => {
  await router.isReady();
  loading.value = false;
});
</script>

<template>
  <div v-if="loading" class="loading-screen">Loading MyOTA administration…</div>
  <router-view v-else v-slot="{ Component }">
    <AppShell v-if="!route.meta.public"><component :is="Component" /></AppShell>
    <component :is="Component" v-else />
  </router-view>
</template>
