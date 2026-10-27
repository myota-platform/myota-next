<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { apiRequest } from '../lib/api';
import { usePageFeedback } from '../composables/usePageFeedback';
import PageHeader from '../components/PageHeader.vue';
import PageFeedback from '../components/PageFeedback.vue';

interface Participant {
  id: string;
  displayName: string;
  email: string | null;
  emailVerified: boolean;
  status: string;
  createdAt: string;
  updatedAt: string;
}
interface ParticipantPage {
  items: Participant[];
  page: number;
  total: number;
  nextPage: number | null;
}

const feedback = usePageFeedback();
const { loading, saving, error, message } = feedback;
const items = ref<Participant[]>([]);
const selected = ref<Participant | null>(null);
const search = ref('');
const page = ref(1);
const nextPage = ref<number | null>(null);
const total = ref(0);
const displayName = ref('');
const pageSummary = computed(() =>
  total.value
    ? `Page ${page.value} · ${total.value} participants`
    : 'No participants found',
);

async function fetchPage(targetPage = page.value) {
  const result = await apiRequest<ParticipantPage>(
    `/v1/identity/admin/participants?page=${targetPage}&pageSize=50&q=${encodeURIComponent(search.value.trim())}`,
  );
  items.value = result.items || [];
  page.value = result.page || targetPage;
  nextPage.value = result.nextPage ?? null;
  total.value = result.total || 0;
  if (selected.value)
    selected.value =
      items.value.find((item) => item.id === selected.value?.id) || null;
}

async function load() {
  await feedback.run(fetchPage);
}

async function findParticipants() {
  selected.value = null;
  page.value = 1;
  await load();
}

function selectParticipant(participant: Participant) {
  selected.value = participant;
  displayName.value = participant.displayName;
}

async function updateParticipant(changes: Record<string, string>) {
  if (!selected.value) return;
  await feedback.run(
    async () => {
      const updated = await apiRequest<Participant>(
        `/v1/identity/admin/participants/${encodeURIComponent(selected.value!.id)}`,
        { method: 'PATCH', body: JSON.stringify(changes) },
      );
      selected.value = updated;
      displayName.value = updated.displayName;
      await fetchPage();
    },
    { mutation: true, success: 'Participant account updated.' },
  );
}

async function saveDisplayName() {
  await updateParticipant({ displayName: displayName.value.trim() });
}

async function toggleSuspension() {
  if (!selected.value) return;
  const suspending = selected.value.status !== 'SUSPENDED';
  if (
    suspending &&
    !window.confirm(`Suspend sign-in for ${selected.value.displayName}?`)
  )
    return;
  await updateParticipant({ status: suspending ? 'SUSPENDED' : 'ACTIVE' });
}

async function changePage(target: number) {
  if (target < 1 || loading.value) return;
  selected.value = null;
  await feedback.run(() => fetchPage(target));
}

onMounted(load);
</script>

<template>
  <PageHeader :refresh="load" :busy="loading || saving" />
  <PageFeedback :error="error" :message="message" :loading="loading" />
  <section class="panel">
    <div class="panel-heading">
      <div>
        <h2>Participant accounts</h2>
        <p class="field-help">
          Search and manage participant accounts. Administrator accounts, role
          grants, and role definitions are outside this workspace.
        </p>
      </div>
    </div>
    <form class="toolbar" @submit.prevent="findParticipants">
      <label>
        Search participants
        <input v-model="search" type="search" maxlength="120" />
      </label>
      <button class="primary" type="submit" :disabled="loading || saving">
        Search
      </button>
    </form>
    <p class="field-help" aria-live="polite">{{ pageSummary }}</p>
    <div
      class="table-scroll"
      role="region"
      aria-label="Participant accounts"
      tabindex="0"
    >
      <table class="operations-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Email status</th>
            <th>Account status</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="participant in items" :key="participant.id">
            <td>
              <button
                class="link-button"
                type="button"
                @click="selectParticipant(participant)"
              >
                {{ participant.displayName }}
              </button>
            </td>
            <td>{{ participant.email || '—' }}</td>
            <td>
              {{ participant.emailVerified ? 'Verified' : 'Not verified' }}
            </td>
            <td>{{ participant.status }}</td>
            <td>{{ participant.createdAt }}</td>
          </tr>
          <tr v-if="!items.length">
            <td colspan="5">No participant accounts match this search.</td>
          </tr>
        </tbody>
      </table>
    </div>
    <nav class="entity-pagination" aria-label="Participant pages">
      <button
        class="secondary"
        type="button"
        :disabled="page <= 1 || loading"
        @click="changePage(page - 1)"
      >
        Previous
      </button>
      <button
        class="secondary"
        type="button"
        :disabled="!nextPage || loading"
        @click="changePage(nextPage || page + 1)"
      >
        Next
      </button>
    </nav>
  </section>
  <section v-if="selected" class="panel">
    <h2>{{ selected.displayName }}</h2>
    <dl>
      <dt>Email</dt>
      <dd>{{ selected.email || '—' }}</dd>
      <dt>Email verification</dt>
      <dd>{{ selected.emailVerified ? 'Verified' : 'Not verified' }}</dd>
      <dt>Account status</dt>
      <dd>{{ selected.status }}</dd>
      <dt>Created</dt>
      <dd>{{ selected.createdAt }}</dd>
      <dt>Updated</dt>
      <dd>{{ selected.updatedAt }}</dd>
    </dl>
    <form class="toolbar" @submit.prevent="saveDisplayName">
      <label>
        Display name
        <input v-model="displayName" required maxlength="120" />
      </label>
      <button
        class="primary"
        type="submit"
        :disabled="saving || !displayName.trim()"
      >
        Save name
      </button>
    </form>
    <button
      class="secondary"
      type="button"
      :disabled="saving"
      @click="toggleSuspension"
    >
      {{
        selected.status === 'SUSPENDED'
          ? 'Reactivate sign-in'
          : 'Suspend sign-in'
      }}
    </button>
  </section>
</template>
