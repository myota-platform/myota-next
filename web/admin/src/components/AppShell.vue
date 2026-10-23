<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAppStore } from '../stores/app';
import { availablePages, pageFor } from '../lib/adminNavigation';
const store = useAppStore();
const route = useRoute();
const router = useRouter();
const sidebarOpen = ref(false);
const navigation = ref<HTMLElement | null>(null);
const navigationToggle = ref<HTMLButtonElement | null>(null);
watch(sidebarOpen, async (open) => {
  await nextTick();
  if (open) navigation.value?.querySelector<HTMLInputElement>('input')?.focus();
});
function closeNavigation(): void {
  sidebarOpen.value = false;
  navigationToggle.value?.focus();
}
function navigationKey(event: KeyboardEvent): void {
  if (!sidebarOpen.value) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeNavigation();
    return;
  }
  if (event.key !== 'Tab') return;
  const controls = [
    ...(navigation.value?.querySelectorAll<HTMLElement>('a, button, input') ||
      []),
  ];
  const first = controls[0];
  const last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
const search = ref('');
const error = ref('');
const pages = computed(() => availablePages(store.account));
const sections = computed(() =>
  [...new Set(pages.value.map((page) => page.group))]
    .map((label) => ({
      label,
      items: pages.value.filter(
        (page) =>
          page.group === label &&
          (page.title + ' ' + page.description)
            .toLowerCase()
            .includes(search.value.toLowerCase().trim()),
      ),
    }))
    .filter((section) => section.items.length),
);
const current = computed(() => pageFor(route.path));
watch(
  () => store.account,
  async (account) => {
    const page = pageFor(route.path);
    if (account && page && !page.allowed(account))
      await router.replace('/access-denied');
  },
);
const pageTitle = computed(
  () => current.value?.title || String(route.meta.title || 'Administration'),
);
const scopeLabel = computed(() =>
  current.value?.programmeScoped
    ? store.programmes.find((item) => item.slug === store.currentProgramme)
        ?.name || 'Choose a programme below'
    : 'Platform-wide',
);
watch(
  () => route.fullPath,
  () => {
    sidebarOpen.value = false;
    error.value = '';
  },
);
async function signOut(): Promise<void> {
  store.signOut();
  await router.push('/login');
}
async function sessionInvalid(): Promise<void> {
  store.signOut();
  if (route.path !== '/login') await router.replace('/login');
}
onMounted(() =>
  window.addEventListener('myota:session-invalid', sessionInvalid),
);
onUnmounted(() =>
  window.removeEventListener('myota:session-invalid', sessionInvalid),
);
</script>
<template>
  <a class="skip-link" href="#workspace-content">Skip to workspace</a>
  <header class="topbar">
    <button
      ref="navigationToggle"
      class="mobile-menu"
      aria-label="Toggle navigation"
      :aria-expanded="sidebarOpen"
      aria-controls="admin-navigation"
      @click="sidebarOpen = !sidebarOpen"
    >
      ☰
    </button>
    <RouterLink class="brand" to="/dashboard"
      ><span class="brand-mark">M</span
      ><span
        ><strong>MyOTA</strong><small>Administration</small></span
      ></RouterLink
    >
    <div class="top-actions">
      <span class="scope-indicator" :title="scopeLabel">{{ scopeLabel }}</span
      ><span class="status-dot" :class="store.apiStatus">{{
        store.apiStatus === 'connected' ? 'API connected' : 'API warning'
      }}</span
      ><span class="account-label">{{
        store.account?.displayName || store.account?.email
      }}</span
      ><span class="utc-indicator">UTC</span
      ><button class="quiet" @click="signOut">Sign out</button>
    </div>
  </header>
  <button
    v-if="sidebarOpen"
    class="nav-scrim"
    aria-label="Close navigation"
    @click="closeNavigation"
  />
  <div class="app-layout">
    <aside
      ref="navigation"
      id="admin-navigation"
      class="sidebar"
      :class="{ open: sidebarOpen }"
      aria-label="Administration navigation"
      @keydown="navigationKey"
    >
      <label class="nav-search"
        >Find a workspace<input
          v-model="search"
          type="search"
          placeholder="Search navigation"
      /></label>
      <nav
        v-for="section in sections"
        :key="section.label"
        class="nav-section"
        :aria-label="section.label"
      >
        <p class="nav-section-label">{{ section.label }}</p>
        <template v-for="item in section.items" :key="item.path">
          <RouterLink
            class="nav-item"
            :class="{ active: route.path === item.path }"
            :aria-current="route.path === item.path ? 'page' : undefined"
            :to="item.path"
            ><span class="nav-item-icon" aria-hidden="true">{{
              item.icon
            }}</span
            >{{ item.title }}</RouterLink
          >
        </template>
      </nav>
      <p v-if="!sections.length" class="muted">
        No available workspace matches this search.
      </p>
      <div class="sidebar-footer">
        <p class="scope-note">
          Workspaces reflect your permissions. Shared entities and imports are
          platform-wide. All operational times are UTC.
        </p>
      </div>
    </aside>
    <main id="workspace-content" class="content" tabindex="-1">
      <nav class="breadcrumbs" aria-label="Breadcrumb">
        <RouterLink to="/dashboard">MyOTA</RouterLink
        ><span v-if="current?.group && current.group !== 'Start'"
          >/ {{ current.group }}</span
        ><span>/</span><strong>{{ pageTitle }}</strong>
      </nav>
      <div v-if="store.bootstrapWarning" class="warning-banner" role="status">
        {{ store.bootstrapWarning }}
        <button
          class="link-button"
          @click="store.loadProgrammes().catch(() => {})"
        >
          Retry programme choices
        </button>
      </div>
      <div v-if="error" class="error-card" role="alert">{{ error }}</div>
      <slot />
    </main>
  </div>
</template>
