<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { apiRequest } from '../lib/api';
import { hasAnyScope } from '../lib/adminAccess';
import { availablePages } from '../lib/adminNavigation';
import { utcDisplay } from '../lib/utc';
import { useAppStore } from '../stores/app';
import { usePageFeedback } from '../composables/usePageFeedback';
import PageHeader from '../components/PageHeader.vue';
import PageFeedback from '../components/PageFeedback.vue';
const store = useAppStore();
const { loading, error, run } = usePageFeedback();
const counts = ref<Record<string, number | null>>({});
const reviewItems = ref<
  Array<{ id: string; name: string; programmeSlug?: string }>
>([]);
const securityEvents = ref<
  Array<{ id?: string; eventType: string; occurredAt?: string }>
>([]);
const canReview = computed(() => hasAnyScope(store.account, 'geodata.review'));
const canIdentity = computed(() =>
  hasAnyScope(store.account, 'identity.admin'),
);
const canActivity = computed(() =>
  hasAnyScope(store.account, 'activity.read', 'activity.admin'),
);
const canProgramme = computed(() =>
  hasAnyScope(store.account, 'programme.admin'),
);
const quickPages = computed(() =>
  availablePages(store.account).filter((page) =>
    [
      '/geodata',
      '/geodata-imports',
      '/entity-management',
      '/awards',
      '/programmes',
      '/identity',
    ].includes(page.path),
  ),
);
const metrics = computed(() =>
  [
    {
      key: 'programmes',
      label: 'Programmes',
      show: canProgramme.value,
      help: 'available programme configurations',
    },
    {
      key: 'review',
      label: 'Review candidates',
      show: canReview.value,
      help: 'awaiting a status decision',
    },
    {
      key: 'accounts',
      label: 'Users',
      show: canIdentity.value,
      help: 'identity records',
    },
    {
      key: 'activity',
      label: 'Activations',
      show: canActivity.value,
      help: 'recorded activations',
    },
  ].filter((item) => item.show),
);
async function load(refreshProgrammes = true): Promise<void> {
  await run(async () => {
    const failures: string[] = [];
    if (canProgramme.value) {
      try {
        if (refreshProgrammes || !store.programmesLoaded)
          await store.loadProgrammes();
        counts.value.programmes = store.programmes.length;
      } catch {
        counts.value.programmes = null;
        failures.push('programme data is unavailable');
      }
    }
    const requests: Array<{ key: string; path: string; enabled: boolean }> = [
      {
        key: 'review',
        path: '/v1/geodata/entities?status=CANDIDATE&pageSize=5',
        enabled: canReview.value,
      },
      {
        key: 'accounts',
        path: '/v1/identity/admin/accounts?pageSize=1',
        enabled: canIdentity.value,
      },
      {
        key: 'security',
        path: '/v1/identity/admin/security-events?pageSize=5',
        enabled: canIdentity.value,
      },
      {
        key: 'activity',
        path: '/v1/activations?pageSize=1',
        enabled: canActivity.value,
      },
    ];
    await Promise.all(
      requests
        .filter((item) => item.enabled)
        .map(async (item) => {
          try {
            const data = await apiRequest<{
              total?: number;
              items?: unknown[];
            }>(item.path);
            counts.value[item.key] = data.total ?? null;
            if (item.key === 'review')
              reviewItems.value = (data.items ||
                []) as typeof reviewItems.value;
            if (item.key === 'security')
              securityEvents.value = (data.items ||
                []) as typeof securityEvents.value;
          } catch {
            counts.value[item.key] = null;
            failures.push(item.key + ' data is unavailable');
          }
        }),
    );
    error.value = failures.length
      ? failures.join('; ') + '. Other workspaces remain available.'
      : '';
  });
}
onMounted(() => load(false));
</script>
<template>
  <PageHeader :refresh="load" :busy="loading" />
  <PageFeedback
    :error="error"
    :loading="loading"
    loading-label="Refreshing your available overview…"
  />
  <div v-if="metrics.length" class="metrics">
    <article v-for="item in metrics" :key="item.key" class="metric">
      <span>{{ item.label }}</span
      ><strong>{{ counts[item.key] ?? '—' }}</strong
      ><small>{{
        counts[item.key] == null ? 'Not available yet' : item.help
      }}</small>
    </article>
  </div>
  <article class="panel dashboard-tasks">
    <div class="panel-heading">
      <div>
        <h2>Start a task</h2>
        <p class="muted">
          Choose a workflow; your permissions determine what is available.
        </p>
      </div>
    </div>
    <div class="task-grid">
      <RouterLink
        v-for="page in quickPages"
        :key="page.path"
        :to="page.path"
        class="task-card"
        ><strong>{{ page.title }} →</strong
        ><small>{{ page.description }}</small></RouterLink
      >
    </div>
    <p v-if="!quickPages.length" class="muted">
      Use your available workspaces in the navigation. If you need additional
      administration access, ask a global administrator.
    </p>
  </article>
  <div class="dashboard-grid">
    <article v-if="canReview" class="panel">
      <div class="panel-heading">
        <h2>Candidates needing review</h2>
        <RouterLink class="link-button" to="/geodata"
          >Open review queue</RouterLink
        >
      </div>
      <div class="compact-list">
        <div v-for="item in reviewItems" :key="item.id" class="list-row">
          <span class="status-pill candidate">Candidate</span>
          <div>
            <strong>{{ item.name }}</strong
            ><small>{{
              item.programmeSlug || 'Unassigned / platform-wide'
            }}</small>
          </div>
          <RouterLink class="link-button" to="/geodata">Review</RouterLink>
        </div>
        <p
          v-if="!reviewItems.length && counts.review != null"
          class="muted empty"
        >
          No candidates are waiting.
        </p>
      </div>
    </article>
    <article v-if="canIdentity" class="panel">
      <div class="panel-heading">
        <h2>Recent security events</h2>
        <RouterLink class="link-button" to="/identity?tab=security"
          >View security events</RouterLink
        >
      </div>
      <div class="compact-list">
        <div
          v-for="event in securityEvents"
          :key="event.id || event.occurredAt"
          class="list-row"
        >
          <div>
            <strong>{{ event.eventType }}</strong
            ><small>{{ utcDisplay(event.occurredAt) }}</small>
          </div>
        </div>
        <p
          v-if="!securityEvents.length && counts.security != null"
          class="muted empty"
        >
          No recent security events.
        </p>
      </div>
    </article>
  </div>
</template>
