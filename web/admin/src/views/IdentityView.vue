<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError, apiRequest } from '../lib/api';
import { myotaClient } from '../lib/myotaClient';
import {
  hasAnyScope,
  mayGrantRole,
  roleAssignmentPayload,
  type RoleAssignment,
} from '../lib/adminAccess';
import { utcDisplay } from '../lib/utc';
import { useAppStore } from '../stores/app';
import { usePageFeedback } from '../composables/usePageFeedback';
import PageHeader from '../components/PageHeader.vue';
import PageFeedback from '../components/PageFeedback.vue';
import PageNavigation from '../components/PageNavigation.vue';

interface Role {
  code: string;
  name: string;
  description?: string;
  scopes: string[];
  system?: boolean;
}
interface User {
  id: string;
  displayName: string;
  email?: string;
  status: string;
  participationType?: string;
  primaryCallsignId?: string | null;
  callsigns?: Callsign[];
  roles?: RoleAssignment[];
  scopes?: string[];
}
interface Callsign {
  id: string;
  value: string;
  status: string;
  source?: string | null;
  verificationSource?: string | null;
  verifiedAt?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  evidenceIds: string[];
}
interface Permission {
  code: string;
  label: string;
}
interface SecurityEvent {
  id?: string;
  occurredAt?: string;
  eventType: string;
  payload?: { accountId?: string };
}

interface Page<T> {
  items: T[];
  page: number;
  total: number;
  nextPage: number | null;
}
const store = useAppStore();
const route = useRoute();
const router = useRouter();
const feedback = usePageFeedback();
const { loading, saving, error, message } = feedback;
const accounts = ref<User[]>([]);
const accountPage = ref(1);
const accountNextPage = ref<number | null>(null);
const accountTotal = ref(0);
const roles = ref<Role[]>([]);
const permissions = ref<Permission[]>([]);
const securityEvents = ref<SecurityEvent[]>([]);
const securityEventPage = ref(1);
const securityEventNextPage = ref<number | null>(null);
const securityEventTotal = ref(0);
const selectedAccount = ref<User | null>(null);
const selectedRole = ref<Role | null>(null);
const search = ref('');
const creatingAccount = ref(false);
const accountCreateForm = reactive({
  displayName: '',
  email: '',
  participationType: 'OPERATOR',
  callsign: '',
  roles: [] as string[],
});
const canManageUsers = computed(() =>
  hasAnyScope(store.account, 'identity.admin'),
);
const canCreateAccounts = computed(() =>
  hasAnyScope(store.account, 'identity.accounts.create'),
);
const canGrantAdditionalRoles = computed(
  () =>
    canCreateAccounts.value &&
    hasAnyScope(store.account, 'identity.roles.assign'),
);
const canManageRoles = computed(() =>
  hasAnyScope(store.account, 'identity.roles.manage'),
);
const canViewRoleDefinitions = computed(
  () => canManageUsers.value || canManageRoles.value,
);
const tabs = computed(() => [
  ...(canManageUsers.value || canCreateAccounts.value
    ? [{ id: 'users', label: 'Users' }]
    : []),
  ...(canViewRoleDefinitions.value
    ? [{ id: 'roles', label: 'Roles & permissions' }]
    : []),
  ...(canManageUsers.value
    ? [{ id: 'security', label: 'Security events' }]
    : []),
]);
const creatableRoles = computed(() =>
  roles.value.filter(
    (role) => role.code !== 'PARTICIPANT' && mayGrantRole(store.account, role),
  ),
);
const activeTab = computed(() =>
  tabs.value.some((tab) => tab.id === route.query.tab)
    ? String(route.query.tab)
    : (tabs.value[0]?.id ?? ''),
);
const accountForm = reactive({
  displayName: '',
  email: '',
  status: 'ACTIVE',
  password: '',
  selectedRoles: [] as string[],
});
const callsignForm = reactive({
  callsign: '',
  status: '',
  source: '',
  validFrom: '',
  validTo: '',
});
const evidenceForm = reactive({
  callsignId: '',
  evidenceType: '',
  source: '',
  checksum: '',
  metadata: '',
});
const retireReplacement = ref('');
const retireValidTo = ref('');
const retiringCallsignId = ref('');
const verificationSource = ref('manual-review');
const pendingCallsignMutationStorageKey =
  'myota_admin_pending_callsign_mutations';
const restoredCallsignMutations = restorePendingCallsignMutations();
const pendingAccountCreates = restoredCallsignMutations.accounts;
const pendingCallsignCreates = restoredCallsignMutations.create;
const pendingPrimaryCallsignChanges = restoredCallsignMutations.primary;
const retiringCallsign = computed(() =>
  selectedAccount.value?.callsigns?.find(
    (callsign) => callsign.id === retiringCallsignId.value,
  ),
);
const canManageSelectedCallsigns = computed(
  () =>
    Boolean(selectedAccount.value) &&
    (selectedAccount.value?.id === store.account?.id ||
      hasAnyScope(store.account, '*')),
);
const canVerifyCallsigns = computed(() =>
  hasAnyScope(store.account, 'callsign.verify'),
);

function restorePendingCallsignMutations(): {
  accounts: Map<string, string>;
  create: Map<string, string>;
  primary: Map<string, string>;
} {
  try {
    const saved = JSON.parse(
      sessionStorage.getItem(pendingCallsignMutationStorageKey) || '{}',
    );
    const accounts = new Map<string, string>(
      Array.isArray(saved.accounts)
        ? saved.accounts.filter(
            (entry: unknown) =>
              Array.isArray(entry) &&
              typeof entry[0] === 'string' &&
              typeof entry[1] === 'string',
          )
        : [],
    );
    const create = new Map<string, string>(
      Array.isArray(saved.create)
        ? saved.create.filter(
            (entry: unknown) =>
              Array.isArray(entry) &&
              typeof entry[0] === 'string' &&
              typeof entry[1] === 'string',
          )
        : [],
    );
    const primary = new Map<string, string>(
      Array.isArray(saved.primary)
        ? saved.primary.filter(
            (entry: unknown) =>
              Array.isArray(entry) &&
              typeof entry[0] === 'string' &&
              typeof entry[1] === 'string',
          )
        : [],
    );
    return { accounts, create, primary };
  } catch {
    return { accounts: new Map(), create: new Map(), primary: new Map() };
  }
}

function persistPendingCallsignMutations(): void {
  try {
    sessionStorage.setItem(
      pendingCallsignMutationStorageKey,
      JSON.stringify({
        accounts: [...pendingAccountCreates.entries()],
        create: [...pendingCallsignCreates.entries()],
        primary: [...pendingPrimaryCallsignChanges.entries()],
      }),
    );
  } catch {
    // In-memory retry keys remain available when browser storage is unavailable.
  }
}

const roleForm = reactive({
  code: '',
  name: '',
  description: '',
  scopes: [] as string[],
});
const canAssignRoles = computed(() => {
  const target = selectedAccount.value;
  if (
    !target ||
    !hasAnyScope(store.account, 'identity.roles.assign') ||
    target.id === store.account?.id
  )
    return false;
  return true;
});
function canEditRole(role: Role): boolean {
  const selected = accountForm.selectedRoles.includes(role.code);
  const alreadyAssigned = selectedAccount.value?.roles?.some(
    (assignment) => assignment.role === role.code,
  );
  return (
    Boolean(selectedAccount.value) &&
    selectedAccount.value?.id !== store.account?.id &&
    (mayGrantRole(store.account, role) || Boolean(selected && alreadyAssigned))
  );
}
function effectivePermissions(account: User): string[] {
  return [...new Set(account.scopes || [])].sort();
}
const roleEditable = computed(
  () => canManageRoles.value && !selectedRole.value?.system,
);
const rolesChanged = computed(
  () =>
    JSON.stringify([...new Set(accountForm.selectedRoles)].sort()) !==
    JSON.stringify(
      [
        ...new Set(
          selectedAccount.value?.roles?.map((role) => role.role) || [],
        ),
      ].sort(),
    ),
);

function editAccount(account: User): void {
  selectedAccount.value = JSON.parse(JSON.stringify(account));
  Object.assign(accountForm, {
    displayName: account.displayName,
    email: account.email || '',
    status: account.status,
    password: '',
    selectedRoles: [...new Set((account.roles || []).map((role) => role.role))],
  });
}
async function refreshSelectedCallsigns(accountId: string): Promise<void> {
  await fetchData();
  if (selectedAccount.value?.id !== accountId) return;
  const updated = accounts.value.find((account) => account.id === accountId);
  if (updated) {
    selectedAccount.value = {
      ...selectedAccount.value,
      primaryCallsignId: updated.primaryCallsignId,
      callsigns: updated.callsigns || [],
    };
  }
}
async function addCallsign(): Promise<void> {
  const account = selectedAccount.value;
  if (!account || !canManageSelectedCallsigns.value) return;
  const payload: Record<string, string> = {
    callsign: callsignForm.callsign.trim(),
  };
  if (callsignForm.status) payload.status = callsignForm.status;
  if (callsignForm.source) payload.source = callsignForm.source;
  if (callsignForm.validFrom) payload.validFrom = callsignForm.validFrom;
  if (callsignForm.validTo) payload.validTo = callsignForm.validTo;
  const fingerprint = JSON.stringify([account.id, payload]);
  let idempotencyKey = pendingCallsignCreates.get(fingerprint);
  if (!idempotencyKey) {
    idempotencyKey = crypto.randomUUID();
    pendingCallsignCreates.set(fingerprint, idempotencyKey);
    persistPendingCallsignMutations();
  }
  await feedback.run(
    async () => {
      await myotaClient.addIdentityCallsign(
        account.id,
        payload,
        idempotencyKey,
      );
      await refreshSelectedCallsigns(account.id);
      pendingCallsignCreates.delete(fingerprint);
      persistPendingCallsignMutations();
      Object.assign(callsignForm, {
        callsign: '',
        status: '',
        source: '',
        validFrom: '',
        validTo: '',
      });
    },
    { mutation: true, success: 'Callsign added.' },
  );
}
async function submitCallsignEvidence(): Promise<void> {
  const account = selectedAccount.value;
  const callsignId = evidenceForm.callsignId;
  if (!account || !callsignId || !canManageSelectedCallsigns.value) return;
  let metadata: Record<string, unknown> | null | undefined;
  if (evidenceForm.metadata.trim()) {
    try {
      const parsed: unknown = JSON.parse(evidenceForm.metadata);
      if (
        parsed !== null &&
        (typeof parsed !== 'object' || Array.isArray(parsed))
      )
        throw new Error('Evidence metadata must be a JSON object or null.');
      metadata = parsed as Record<string, unknown> | null;
    } catch (cause) {
      error.value =
        cause instanceof SyntaxError
          ? 'Evidence metadata must contain valid JSON.'
          : cause instanceof Error
            ? cause.message
            : 'Evidence metadata must contain valid JSON.';
      message.value = '';
      return;
    }
  }
  await feedback.run(
    async () => {
      await myotaClient.submitIdentityCallsignEvidence(account.id, callsignId, {
        evidenceType: evidenceForm.evidenceType.trim(),
        source: evidenceForm.source.trim(),
        checksum: evidenceForm.checksum.trim() || undefined,
        ...(metadata === undefined ? {} : { metadata }),
      });
      evidenceForm.callsignId = '';
      evidenceForm.evidenceType = '';
      evidenceForm.source = '';
      evidenceForm.checksum = '';
      evidenceForm.metadata = '';
      await refreshSelectedCallsigns(account.id);
    },
    { mutation: true, success: 'Callsign evidence submitted.' },
  );
}
async function verifyCallsign(callsign: Callsign): Promise<void> {
  const account = selectedAccount.value;
  if (!account || !canVerifyCallsigns.value || !callsign.evidenceIds.length)
    return;
  await feedback.run(
    async () => {
      await myotaClient.verifyIdentityCallsign(account.id, callsign.id, {
        ...(verificationSource.value
          ? { source: verificationSource.value }
          : {}),
      });
      await refreshSelectedCallsigns(account.id);
    },
    { mutation: true, success: 'Callsign verified.' },
  );
}
async function setPrimaryCallsign(callsign: Callsign): Promise<void> {
  const account = selectedAccount.value;
  if (!account || !canManageSelectedCallsigns.value) return;
  const requestId = JSON.stringify([account.id, callsign.id]);
  let idempotencyKey = pendingPrimaryCallsignChanges.get(requestId);
  if (!idempotencyKey) {
    idempotencyKey = crypto.randomUUID();
    pendingPrimaryCallsignChanges.set(requestId, idempotencyKey);
    persistPendingCallsignMutations();
  }
  await feedback.run(
    async () => {
      await myotaClient.setPrimaryIdentityCallsign(
        account.id,
        callsign.id,
        idempotencyKey,
      );
      await refreshSelectedCallsigns(account.id);
      pendingPrimaryCallsignChanges.delete(requestId);
      persistPendingCallsignMutations();
    },
    { mutation: true, success: 'Primary callsign updated.' },
  );
}
async function retireCallsign(callsign: Callsign): Promise<void> {
  const account = selectedAccount.value;
  if (!account || !canManageSelectedCallsigns.value) return;
  const isPrimary = account.primaryCallsignId === callsign.id;
  if (isPrimary && !retireReplacement.value) return;
  if (!window.confirm(`Retire callsign ${callsign.value}?`)) return;
  await feedback.run(
    async () => {
      const payload: Record<string, string> = {};
      if (isPrimary) payload.newPrimaryCallsignId = retireReplacement.value;
      if (retireValidTo.value) payload.validTo = retireValidTo.value;
      await myotaClient.retireIdentityCallsign(
        account.id,
        callsign.id,
        payload,
      );
      retireReplacement.value = '';
      retireValidTo.value = '';
      retiringCallsignId.value = '';
      await refreshSelectedCallsigns(account.id);
    },
    { mutation: true, success: 'Callsign retired.' },
  );
}
async function requestCallsignRetirement(callsign: Callsign): Promise<void> {
  retiringCallsignId.value = callsign.id;
  retireReplacement.value = '';
  retireValidTo.value = '';
}
async function confirmCallsignRetirement(): Promise<void> {
  if (retiringCallsign.value) await retireCallsign(retiringCallsign.value);
}
function editRole(role: Role | null): void {
  selectedRole.value = role ? JSON.parse(JSON.stringify(role)) : null;
  Object.assign(roleForm, {
    code: role?.code || '',
    name: role?.name || '',
    description: role?.description || '',
    scopes: [...(role?.scopes || [])],
  });
}
async function fetchData(page = accountPage.value): Promise<void> {
  const [accountData, roleData, events] = await Promise.all([
    canManageUsers.value
      ? apiRequest<Page<User>>(
          `/v1/identity/admin/accounts?page=${page}&pageSize=50&q=${encodeURIComponent(search.value)}`,
        )
      : Promise.resolve({
          items: [],
          page,
          total: 0,
          nextPage: null,
        }),
    canViewRoleDefinitions.value || canCreateAccounts.value
      ? apiRequest<{ items: Role[]; permissions: Permission[] }>(
          '/v1/identity/admin/roles',
        )
      : Promise.resolve({ items: [], permissions: [] }),
    canManageUsers.value
      ? apiRequest<Page<SecurityEvent>>(
          `/v1/identity/admin/security-events?page=${securityEventPage.value}&pageSize=20`,
        )
      : Promise.resolve({
          items: [],
          page: securityEventPage.value,
          total: 0,
          nextPage: null,
        }),
  ]);
  accounts.value = accountData.items || [];
  accountPage.value = accountData.page || page;
  accountTotal.value = accountData.total || 0;
  accountNextPage.value = accountData.nextPage ?? null;
  roles.value = roleData.items || [];
  permissions.value = roleData.permissions || [];
  securityEvents.value = events.items || [];
  securityEventPage.value = events.page || securityEventPage.value;
  securityEventTotal.value = events.total || 0;
  securityEventNextPage.value = events.nextPage ?? null;
}
async function load(): Promise<void> {
  await feedback.run(fetchData);
}
async function searchAccounts(): Promise<void> {
  accountPage.value = 1;
  selectedAccount.value = null;
  await load();
}
async function changeAccountPage(page: number): Promise<void> {
  if (page < 1 || loading.value) return;
  await feedback.run(async () => {
    await fetchData(page);
    selectedAccount.value = null;
  });
}
async function changeSecurityEventPage(page: number): Promise<void> {
  if (page < 1 || loading.value) return;
  await feedback.run(async () => {
    const result = await apiRequest<Page<SecurityEvent>>(
      `/v1/identity/admin/security-events?page=${page}&pageSize=20`,
    );
    securityEvents.value = result.items || [];
    securityEventPage.value = result.page || page;
    securityEventTotal.value = result.total || 0;
    securityEventNextPage.value = result.nextPage ?? null;
  });
}
async function createAccount(): Promise<void> {
  if (!canCreateAccounts.value) return;
  const payload: Record<string, unknown> = {
    displayName: accountCreateForm.displayName.trim(),
    email: accountCreateForm.email.trim(),
    participationType: accountCreateForm.participationType,
  };
  if (
    accountCreateForm.participationType === 'OPERATOR' &&
    accountCreateForm.callsign.trim()
  )
    payload.callsign = accountCreateForm.callsign.trim();
  if (canGrantAdditionalRoles.value && accountCreateForm.roles.length)
    payload.roles = accountCreateForm.roles
      .filter((code) => creatableRoles.value.some((role) => role.code === code))
      .map((role) => ({ role }));
  const fingerprint = JSON.stringify([store.account?.id, payload]);
  let idempotencyKey = pendingAccountCreates.get(fingerprint);
  if (!idempotencyKey) {
    idempotencyKey = crypto.randomUUID();
    pendingAccountCreates.set(fingerprint, idempotencyKey);
    persistPendingCallsignMutations();
  }
  await feedback.run(
    async () => {
      try {
        await myotaClient.createIdentityAccount<User>(payload, idempotencyKey);
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 403)
          throw new Error(
            'Identity denied account creation or one of the requested role grants. Your permissions may have changed; refresh and try again.',
          );
        if (
          cause instanceof ApiError &&
          cause.status === 400 &&
          /email already exists/i.test(cause.message)
        )
          throw new Error(
            'An account with this email already exists. Search for the existing account instead.',
          );
        throw new Error(
          'Account creation failed. Check the fields and try again.',
        );
      }
      await fetchData();
      pendingAccountCreates.delete(fingerprint);
      persistPendingCallsignMutations();
      accountCreateForm.displayName = '';
      accountCreateForm.email = '';
      accountCreateForm.participationType = 'OPERATOR';
      accountCreateForm.callsign = '';
      accountCreateForm.roles = [];
      creatingAccount.value = false;
    },
    {
      mutation: true,
      success:
        'Account created with status PENDING_SETUP. No invitation was sent; invitation delivery is not available yet.',
    },
  );
}
async function saveAccount(): Promise<void> {
  const account = selectedAccount.value;
  if (!account || !canManageUsers.value) return;
  await feedback.run(
    async () => {
      const payload: Record<string, unknown> = {
        displayName: accountForm.displayName,
        email: accountForm.email || null,
        status: accountForm.status,
        password: accountForm.password || undefined,
      };
      // An unchanged assignment must not be widened or re-granted; scoped grants survive edits.
      if (canAssignRoles.value && rolesChanged.value)
        payload.roles = roleAssignmentPayload(
          accountForm.selectedRoles,
          account.roles || [],
        );
      const saved = await myotaClient.patchIdentityAccount(account.id, payload);
      editAccount(saved as User);
      await fetchData();
    },
    {
      mutation: true,
      success:
        'User saved. Existing scoped role assignments have been preserved.',
    },
  );
}
async function saveRole(): Promise<void> {
  if (!roleEditable.value) return;
  await feedback.run(
    async () => {
      const payload = {
        code: roleForm.code.toUpperCase(),
        name: roleForm.name,
        description: roleForm.description,
        scopes: roleForm.scopes,
      };
      const saved = selectedRole.value
        ? await myotaClient.patchIdentityRole(selectedRole.value.code, payload)
        : await myotaClient.createIdentityRole(payload);
      await fetchData();
      editRole(saved as Role);
    },
    { mutation: true, success: 'Role saved.' },
  );
}
async function exportAccount(account: User): Promise<void> {
  await feedback.run(
    async () => {
      const data = await apiRequest<unknown>(
        `/v1/identity/accounts/${encodeURIComponent(account.id)}/export`,
      );
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `myota-account-${account.id}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    },
    { success: 'Account export downloaded.' },
  );
}
async function deactivateAccount(account: User): Promise<void> {
  if (!window.confirm(`Deactivate and anonymize ${account.displayName}?`))
    return;
  await feedback.run(
    async () => {
      await myotaClient.patchIdentityAccount(account.id, {
        status: 'DEACTIVATED',
        anonymize: true,
      });
      selectedAccount.value = null;
      await fetchData();
    },
    { mutation: true, success: 'Account deactivated and anonymized.' },
  );
}
onMounted(load);
</script>

<template>
  <PageHeader :refresh="load" :busy="loading || saving" />
  <PageFeedback :error="error" :message="message" :loading="loading" />
  <nav class="workspace-tabs" aria-label="People workspaces">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      class="secondary"
      :aria-current="activeTab === tab.id ? 'page' : undefined"
      @click="router.replace({ query: { tab: tab.id } })"
    >
      {{ tab.label }}
    </button>
  </nav>
  <div v-if="activeTab === 'users'" class="identity-grid">
    <article class="panel">
      <div class="panel-heading">
        <h2>Users</h2>
        <button
          v-if="canCreateAccounts"
          class="primary"
          type="button"
          :disabled="saving"
          @click="creatingAccount = !creatingAccount"
        >
          {{ creatingAccount ? 'Cancel account creation' : 'Create account' }}
        </button>
      </div>
      <form
        v-if="creatingAccount && canCreateAccounts"
        class="form-grid account-create-form"
        :aria-busy="saving"
        @submit.prevent="createAccount"
      >
        <h3 class="wide">Create an account</h3>
        <p class="field-help wide">
          New accounts start in PENDING_SETUP with the participant role. No
          password is requested or set.
        </p>
        <fieldset class="editor-fields wide form-grid" :disabled="saving">
          <label
            >Display name<input
              v-model="accountCreateForm.displayName"
              autocomplete="name"
              required
              maxlength="120"
          /></label>
          <label
            >Email<input
              v-model="accountCreateForm.email"
              type="email"
              autocomplete="email"
              required
              maxlength="254"
          /></label>
          <label
            >Participant type<select
              v-model="accountCreateForm.participationType"
            >
              <option value="OPERATOR">Operator</option>
              <option value="SWL">SWL</option>
            </select></label
          >
          <label v-if="accountCreateForm.participationType === 'OPERATOR'"
            >Initial callsign (optional)<input
              v-model="accountCreateForm.callsign"
              autocomplete="off"
              maxlength="24"
          /></label>
          <fieldset
            v-if="canGrantAdditionalRoles && creatableRoles.length"
            class="wide"
            :disabled="saving"
          >
            <legend>Additional roles you may grant</legend>
            <p class="field-help">
              The participant role is always assigned. Identity checks every
              additional grant again when the account is created.
            </p>
            <div class="checkbox-grid">
              <label
                v-for="role in creatableRoles"
                :key="role.code"
                class="check-field"
              >
                <input
                  v-model="accountCreateForm.roles"
                  type="checkbox"
                  :value="role.code"
                />
                <span
                  >{{ role.name
                  }}<small class="field-help"
                    >{{ role.code }} ·
                    {{ role.scopes.join(', ') || 'No permissions' }}</small
                  ></span
                >
              </label>
            </div>
          </fieldset>
          <p
            v-if="canGrantAdditionalRoles && !creatableRoles.length"
            class="field-help wide"
          >
            No additional roles are within your current grant authority.
          </p>
          <p v-if="!canGrantAdditionalRoles" class="field-help wide">
            Only the participant role will be assigned. Administrator role
            grants require separate Identity permission.
          </p>
          <div class="form-actions wide">
            <button class="primary" type="submit" :disabled="saving">
              {{ saving ? 'Creating…' : 'Create account' }}
            </button>
          </div>
        </fieldset>
      </form>
      <form
        v-if="canManageUsers"
        class="toolbar"
        role="search"
        @submit.prevent="searchAccounts"
      >
        <label class="toolbar-field"
          >Search users<input
            v-model="search"
            placeholder="Name or email" /></label
        ><button class="secondary" :disabled="loading || saving">Search</button>
      </form>
      <div v-if="canManageUsers" class="table-list">
        <button
          v-for="account in accounts"
          :key="account.id"
          class="table-row"
          :class="{ selected: selectedAccount?.id === account.id }"
          :disabled="saving"
          @click="editAccount(account)"
        >
          <span
            ><strong>{{ account.displayName }}</strong
            ><small
              >{{ account.email || 'No email' }} ·
              {{ account.participationType || 'Operator' }}</small
            ><small>{{
              account.roles?.map((role) => role.role).join(', ') ||
              'No assigned roles'
            }}</small></span
          >
          <span
            class="status-pill"
            :class="account.status === 'ACTIVE' ? 'approved' : 'muted-pill'"
            >{{ account.status }}</span
          >
        </button>
        <p v-if="!accounts.length && !loading && !error" class="empty muted">
          No users match this search.
        </p>
        <PageNavigation
          class="account-pagination"
          :page="accountPage"
          :next-page="accountNextPage"
          :total="accountTotal"
          count-label="users"
          :busy="loading || saving"
          label="accounts"
          @change="changeAccountPage"
        />
      </div>
      <p v-else-if="!creatingAccount" class="empty muted">
        You can create accounts, but viewing existing accounts requires the
        separate account-management permission.
      </p>
    </article>
    <article class="panel">
      <h2>{{ selectedAccount ? 'Edit user' : 'User details' }}</h2>
      <p v-if="!selectedAccount" class="empty muted">
        <template v-if="canManageUsers">
          Choose a user to edit their details and roles.
        </template>
        <template v-else>
          Existing account details are not available with your current access.
        </template>
      </p>
      <form
        v-else
        class="form-grid"
        :aria-busy="saving"
        @submit.prevent="saveAccount"
      >
        <fieldset class="editor-fields wide form-grid" :disabled="saving">
          <label
            >Display name<input
              v-model="accountForm.displayName"
              required /></label
          ><label
            >Email<input v-model="accountForm.email" type="email"
          /></label>
          <label
            >Status<select v-model="accountForm.status">
              <option>ACTIVE</option>
              <option>DEACTIVATED</option>
            </select></label
          >
          <label
            >Reset password<input
              v-model="accountForm.password"
              type="password"
              autocomplete="new-password"
              placeholder="Leave blank to keep current"
            /><small class="field-help"
              >Saving a new password revokes existing sessions.</small
            ></label
          >
          <fieldset class="wide" :disabled="!canAssignRoles">
            <legend>Assigned roles</legend>
            <p class="field-help">
              Effective permissions:
              {{ effectivePermissions(selectedAccount).join(', ') || 'None' }}
            </p>
            <p class="field-help">
              Existing programme, jurisdiction and category restrictions remain
              unchanged. Newly added roles are unscoped grants.
            </p>
            <p v-if="!canAssignRoles" class="read-only-note">
              Role assignments are read-only for your current permissions or
              because this is your account.
            </p>
            <div class="checkbox-grid">
              <label v-for="role in roles" :key="role.code" class="check-field">
                <input
                  v-model="accountForm.selectedRoles"
                  type="checkbox"
                  :value="role.code"
                  :disabled="!canEditRole(role)"
                />
                <span
                  >{{ role.name
                  }}<small class="field-help"
                    >{{ role.code }} ·
                    {{ role.scopes.join(', ') || 'No permissions' }}
                    <template v-if="!mayGrantRole(store.account, role)">
                      · you may remove an existing assignment but cannot grant
                      it
                    </template></small
                  ></span
                >
              </label>
            </div>
            <ul class="assignment-context">
              <li
                v-for="(assignment, index) in selectedAccount.roles"
                :key="index"
              >
                {{ assignment.role }} ·
                {{ assignment.programmeSlug || 'All programmes' }} ·
                {{ assignment.jurisdiction || 'All jurisdictions' }} ·
                {{ assignment.entityType || 'All categories' }}
              </li>
            </ul>
          </fieldset>
          <div class="form-actions wide">
            <button class="primary" type="submit">
              {{ saving ? 'Saving…' : 'Save user' }}</button
            ><button
              class="secondary"
              type="button"
              @click="exportAccount(selectedAccount)"
            >
              Export account</button
            ><button
              v-if="selectedAccount.status === 'ACTIVE'"
              class="danger"
              type="button"
              @click="deactivateAccount(selectedAccount)"
            >
              Deactivate and anonymize
            </button>
          </div>
        </fieldset>
      </form>
      <section v-if="selectedAccount" class="callsign-management wide">
        <div class="panel-heading">
          <h3>Callsigns</h3>
          <span class="field-help">
            {{ selectedAccount.callsigns?.length || 0 }} registered
          </span>
        </div>
        <div v-if="canVerifyCallsigns" class="form-grid callsign-form">
          <label class="wide">
            Verification source
            <input v-model="verificationSource" placeholder="manual-review" />
          </label>
        </div>
        <p v-if="!selectedAccount.callsigns?.length" class="empty muted">
          No callsigns are registered on this account.
        </p>
        <div v-else class="table-list">
          <div
            v-for="callsign in selectedAccount.callsigns"
            :key="callsign.id"
            class="table-row callsign-row"
          >
            <span>
              <strong>{{ callsign.value }}</strong>
              <small>
                {{ callsign.status }}
                <template
                  v-if="selectedAccount.primaryCallsignId === callsign.id"
                >
                  · Primary
                </template>
                <template v-if="callsign.verificationSource">
                  · Verified by {{ callsign.verificationSource }}
                </template>
              </small>
              <small class="field-help">
                {{ callsign.evidenceIds.length }} evidence record(s)
                <template v-if="callsign.validFrom">
                  · Valid from {{ utcDisplay(callsign.validFrom) }}
                </template>
                <template v-if="callsign.validTo">
                  · Valid to {{ utcDisplay(callsign.validTo) }}
                </template>
              </small>
            </span>
            <span class="callsign-actions">
              <button
                v-if="
                  canVerifyCallsigns &&
                  callsign.status !== 'VERIFIED' &&
                  callsign.status !== 'RETIRED'
                "
                class="secondary"
                type="button"
                :disabled="saving || !callsign.evidenceIds.length"
                :title="
                  callsign.evidenceIds.length
                    ? ''
                    : 'Evidence is required before verification.'
                "
                @click="verifyCallsign(callsign)"
              >
                Verify
              </button>
              <button
                v-if="
                  canManageSelectedCallsigns &&
                  selectedAccount.primaryCallsignId !== callsign.id &&
                  callsign.status !== 'RETIRED'
                "
                class="secondary"
                type="button"
                :disabled="saving"
                @click="setPrimaryCallsign(callsign)"
              >
                Make primary
              </button>
              <button
                v-if="
                  canManageSelectedCallsigns && callsign.status !== 'RETIRED'
                "
                class="danger"
                type="button"
                :disabled="saving"
                @click="requestCallsignRetirement(callsign)"
              >
                Retire
              </button>
            </span>
          </div>
        </div>
        <form
          v-if="canManageSelectedCallsigns"
          class="form-grid callsign-form"
          :aria-busy="saving"
          @submit.prevent="addCallsign"
        >
          <h4 class="wide">Add callsign</h4>
          <label class="wide">
            Callsign
            <input v-model="callsignForm.callsign" required />
          </label>
          <label>
            Initial status
            <select v-model="callsignForm.status">
              <option value="">Default (UNVERIFIED)</option>
              <option>UNVERIFIED</option>
              <option>VERIFIED</option>
            </select>
          </label>
          <label>
            Source
            <input
              v-model="callsignForm.source"
              placeholder="Default: self-asserted"
            />
          </label>
          <label>
            Valid from (ISO 8601)
            <input
              v-model="callsignForm.validFrom"
              placeholder="2026-10-21T12:00:00Z"
            />
          </label>
          <label>
            Valid to (ISO 8601)
            <input
              v-model="callsignForm.validTo"
              placeholder="2026-10-21T12:00:00Z"
            />
          </label>
          <div class="form-actions wide">
            <button class="primary" type="submit" :disabled="saving">
              Add callsign
            </button>
          </div>
        </form>
        <form
          v-if="
            canManageSelectedCallsigns &&
            selectedAccount.callsigns?.some(
              (callsign) => callsign.status !== 'RETIRED',
            )
          "
          class="form-grid callsign-form"
          :aria-busy="saving"
          @submit.prevent="submitCallsignEvidence"
        >
          <h4 class="wide">Submit verification evidence</h4>
          <label>
            Callsign
            <select v-model="evidenceForm.callsignId" required>
              <option disabled value="">Choose a callsign</option>
              <option
                v-for="callsign in selectedAccount.callsigns?.filter(
                  (item) => item.status !== 'RETIRED',
                )"
                :key="callsign.id"
                :value="callsign.id"
              >
                {{ callsign.value }}
              </option>
            </select>
          </label>
          <label>
            Evidence type
            <input v-model="evidenceForm.evidenceType" required />
          </label>
          <label>
            Source
            <input v-model="evidenceForm.source" required />
          </label>
          <label>
            Checksum (optional)
            <input v-model="evidenceForm.checksum" />
          </label>
          <label class="wide">
            Metadata JSON (optional)
            <textarea
              v-model="evidenceForm.metadata"
              placeholder='{"document":"reference"}'
            ></textarea>
          </label>
          <div class="form-actions wide">
            <button class="primary" type="submit" :disabled="saving">
              Submit evidence
            </button>
          </div>
        </form>
        <form
          v-if="retiringCallsign"
          class="form-grid callsign-form"
          :aria-busy="saving"
          @submit.prevent="confirmCallsignRetirement"
        >
          <h4 class="wide">Retire {{ retiringCallsign.value }}</h4>
          <label
            v-if="selectedAccount?.primaryCallsignId === retiringCallsign.id"
            class="wide"
          >
            Replacement primary callsign
            <select v-model="retireReplacement" required>
              <option disabled value="">Choose an active callsign</option>
              <option
                v-for="callsign in selectedAccount?.callsigns?.filter(
                  (item) =>
                    item.id !== retiringCallsignId && item.status !== 'RETIRED',
                )"
                :key="callsign.id"
                :value="callsign.id"
              >
                {{ callsign.value }}
              </option>
            </select>
          </label>
          <label class="wide">
            Valid to (ISO 8601, optional)
            <input
              v-model="retireValidTo"
              placeholder="Defaults to the current time"
            />
          </label>
          <div class="form-actions wide">
            <button
              class="danger"
              type="submit"
              :disabled="
                saving ||
                (selectedAccount?.primaryCallsignId === retiringCallsign.id &&
                  !retireReplacement)
              "
            >
              Retire callsign
            </button>
            <button
              class="secondary"
              type="button"
              :disabled="saving"
              @click="
                retiringCallsignId = '';
                retireReplacement = '';
                retireValidTo = '';
              "
            >
              Cancel
            </button>
          </div>
        </form>
      </section>
    </article>
  </div>
  <div v-if="activeTab === 'roles'" class="identity-grid">
    <article class="panel">
      <div class="panel-heading">
        <h2>Roles & permissions</h2>
        <button
          v-if="canManageRoles"
          class="primary"
          :disabled="saving"
          @click="editRole(null)"
        >
          New custom role
        </button>
      </div>
      <div class="table-list">
        <button
          v-for="role in roles"
          :key="role.code"
          class="table-row"
          :class="{ selected: selectedRole?.code === role.code }"
          :disabled="saving"
          @click="editRole(role)"
        >
          <span
            ><strong>{{ role.name }}</strong
            ><small
              >{{ role.code }} ·
              {{ role.scopes.join(', ') || 'No permissions' }}</small
            ></span
          ><span class="status-pill">{{
            role.system ? 'Built-in' : 'Custom'
          }}</span>
        </button>
      </div>
    </article>
    <article class="panel">
      <h2>{{ selectedRole?.name || 'New custom role' }}</h2>
      <p v-if="!roleEditable" class="read-only-note">
        {{
          selectedRole?.system
            ? 'Built-in roles cannot be changed. Create a custom role for additional permissions.'
            : 'Role definitions are read-only for your current permissions.'
        }}
      </p>
      <form class="form-grid" @submit.prevent="saveRole">
        <fieldset
          class="editor-fields wide form-grid"
          :disabled="!roleEditable || saving"
        >
          <label
            >Role code<input
              v-model="roleForm.code"
              :readonly="Boolean(selectedRole)"
              required
            /><small class="field-help"
              >Stable identifier; cannot be renamed.</small
            ></label
          >
          <label>Display name<input v-model="roleForm.name" required /></label
          ><label class="wide"
            >Description<textarea v-model="roleForm.description"></textarea>
          </label>
          <fieldset class="wide">
            <legend>Administrative permissions</legend>
            <div class="checkbox-grid">
              <label
                v-for="permission in permissions"
                :key="permission.code"
                class="check-field"
                ><input
                  v-model="roleForm.scopes"
                  type="checkbox"
                  :value="permission.code"
                /><span
                  >{{ permission.code
                  }}<small class="field-help">{{
                    permission.label
                  }}</small></span
                ></label
              >
            </div>
          </fieldset>
          <div v-if="roleEditable" class="form-actions wide">
            <button class="primary" type="submit">
              {{ saving ? 'Saving…' : 'Save role' }}
            </button>
          </div>
        </fieldset>
      </form>
    </article>
  </div>
  <article v-if="activeTab === 'security'" class="panel">
    <h2>Recent security events</h2>
    <p class="muted">Audit history in UTC.</p>
    <div class="table-list">
      <div
        v-for="event in securityEvents"
        :key="event.id || event.occurredAt"
        class="table-row"
      >
        <span
          ><strong>{{ event.eventType }}</strong
          ><small
            >{{ utcDisplay(event.occurredAt) }} ·
            {{ event.payload?.accountId || 'system' }}</small
          ></span
        >
      </div>
      <p
        v-if="!securityEvents.length && !loading && !error"
        class="muted empty"
      >
        No recent security events.
      </p>
    </div>
    <PageNavigation
      class="security-event-pagination"
      :page="securityEventPage"
      :next-page="securityEventNextPage"
      :total="securityEventTotal"
      count-label="audit events"
      :busy="loading"
      label="security events"
      @change="changeSecurityEventPage"
    />
  </article>
</template>
