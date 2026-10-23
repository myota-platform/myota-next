<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { accessTokenExpiresIn, refreshSession } from '../lib/api';

const router = useRouter();
const renewalFailed = ref(false);
let refreshTimer = 0;
let refreshing = false;

async function keepGrafanaSessionAlive(): Promise<void> {
  if (refreshing) return;
  const secondsRemaining = accessTokenExpiresIn();
  if (secondsRemaining === null || secondsRemaining > 120) return;

  refreshing = true;
  try {
    renewalFailed.value = !(await refreshSession());
  } finally {
    refreshing = false;
  }
}

function handleVisibilityChange(): void {
  if (!document.hidden) void keepGrafanaSessionAlive();
}

function returnToSignIn(): void {
  void router.push({ path: '/login', query: { redirect: '/grafana' } });
}

onMounted(() => {
  void keepGrafanaSessionAlive();
  refreshTimer = window.setInterval(() => {
    void keepGrafanaSessionAlive();
  }, 30_000);
  document.addEventListener('visibilitychange', handleVisibilityChange);
});

onBeforeUnmount(() => {
  window.clearInterval(refreshTimer);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
});
</script>

<template>
  <section class="grafana-view" aria-label="Grafana dashboards">
    <div v-if="renewalFailed" class="warning-banner" role="status">
      Your Grafana session could not be renewed. Sign in again if dashboards
      stop loading.
      <button class="link-button" @click="returnToSignIn">
        Return to sign in
      </button>
    </div>
    <iframe
      class="grafana-frame"
      src="/observability/"
      title="MyOTA Grafana dashboards"
      allowfullscreen
    />
  </section>
</template>

<style scoped>
.grafana-view {
  min-height: calc(100dvh - 190px);
}

.grafana-frame {
  display: block;
  width: 100%;
  height: calc(100dvh - 220px);
  min-height: 560px;
  border: 0;
  border-radius: 8px;
  background: #fff;
}
</style>
