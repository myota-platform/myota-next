import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { ApiError, apiRequest, clearSession, saveSession } from '../lib/api';
import type { Account, Programme } from '../types';

export const useAppStore = defineStore('app', () => {
  const account = ref<Account | null>(null);
  const programmes = ref<Programme[]>([]);
  const programmesLoaded = ref(false);
  const currentProgramme = ref('');
  const apiStatus = ref<'pending' | 'connected' | 'unavailable'>('pending');
  const initialized = ref(false);
  const bootstrapWarning = ref('');
  let bootstrapPending: Promise<boolean> | null = null;
  let authorizationRefreshPending: Promise<void> | null = null;
  let sessionRevision = 0;
  const signedIn = computed(() => Boolean(account.value));

  async function bootstrap(): Promise<boolean> {
    if (initialized.value && account.value) return true;
    if (bootstrapPending) return bootstrapPending;
    const pending = initialize(sessionRevision);
    bootstrapPending = pending;
    try {
      return await pending;
    } finally {
      if (bootstrapPending === pending) bootstrapPending = null;
    }
  }

  async function initialize(revision: number): Promise<boolean> {
    bootstrapWarning.value = '';
    try {
      const resolved = await apiRequest<Account>('/v1/identity/me');
      if (revision !== sessionRevision) return false;
      account.value = resolved;
      apiStatus.value = 'connected';
      try {
        await loadProgrammes();
      } catch {
        bootstrapWarning.value =
          'Programme choices are temporarily unavailable. Your session is still active.';
        apiStatus.value = 'unavailable';
      }
      if (revision !== sessionRevision) return false;
      initialized.value = true;
      return true;
    } catch (cause) {
      if (revision !== sessionRevision) return false;
      apiStatus.value = 'unavailable';
      if (cause instanceof ApiError && [401, 403].includes(cause.status))
        signOut();
      else
        bootstrapWarning.value =
          'Unable to check your session. Please retry when the API is available.';
      return false;
    }
  }

  async function loadProgrammes(): Promise<void> {
    const revision = sessionRevision;
    const items: Programme[] = [];
    let page = 1;
    while (true) {
      const data = await apiRequest<{
        items: Programme[];
        nextPage: number | null;
      }>(`/v1/programmes?page=${page}&pageSize=100`);
      items.push(...(data.items || []));
      if (data.nextPage === null) break;
      if (data.nextPage <= page)
        throw new Error('Programme catalogue pagination did not advance.');
      page = data.nextPage;
    }
    if (revision !== sessionRevision) return;
    programmes.value = items;
    programmesLoaded.value = true;
    bootstrapWarning.value = '';
    apiStatus.value = 'connected';
  }

  async function signIn(email: string, password: string): Promise<void> {
    const data = await apiRequest<{
      accessToken: string;
      refreshToken?: string;
      account: Account;
    }>(
      '/v1/identity/auth/login',
      { method: 'POST', body: JSON.stringify({ email, password }) },
      false,
    );
    sessionRevision++;
    bootstrapPending = null;
    saveSession(data);
    // Login returns the basic account record; /me is the canonical response
    // containing resolved roles and scopes needed by permission-gated controls.
    initialized.value = false;
    if (!(await bootstrap()))
      throw new Error('Unable to verify the signed-in account. Please retry.');
  }

  function signOut(): void {
    sessionRevision++;
    bootstrapPending = null;
    account.value = null;
    initialized.value = false;
    programmes.value = [];
    programmesLoaded.value = false;
    currentProgramme.value = '';
    clearSession();
  }

  async function refreshAuthorization(): Promise<void> {
    if (!account.value) return;
    if (authorizationRefreshPending) return authorizationRefreshPending;
    const revision = sessionRevision;
    const pending = (async () => {
      try {
        const resolved = await apiRequest<Account>(
          '/v1/identity/me',
          {},
          false,
        );
        if (revision === sessionRevision) {
          account.value = resolved;
          apiStatus.value = 'connected';
          bootstrapWarning.value = '';
        }
      } catch (cause) {
        if (revision !== sessionRevision) return;
        if (cause instanceof ApiError && [401, 403].includes(cause.status))
          signOut();
        else {
          apiStatus.value = 'unavailable';
          bootstrapWarning.value =
            'Unable to refresh account permissions. Some actions may remain unavailable until the API responds.';
        }
      }
    })();
    authorizationRefreshPending = pending;
    try {
      await pending;
    } finally {
      if (authorizationRefreshPending === pending)
        authorizationRefreshPending = null;
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('myota:authorization-denied', () => {
      void refreshAuthorization();
    });
  }

  return {
    account,
    programmes,
    programmesLoaded,
    currentProgramme,
    apiStatus,
    initialized,
    signedIn,
    bootstrapWarning,
    bootstrap,
    refreshAuthorization,
    loadProgrammes,
    signIn,
    signOut,
  };
});
