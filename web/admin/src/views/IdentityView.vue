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
  roles?: RoleAssignment[];
  scopes?: string[];
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
const store = useAppStore();
const route = useRoute();
const router = useRouter();
const feedback = usePageFeedback();
const { loading, saving, error, message } = feedback;
const accounts = ref<User[]>([]);
const roles = ref<Role[]>([]);
const permissions = ref<Permission[]>([]);
const securityEvents = ref<SecurityEvent[]>([]);
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
function editRole(role: Role | null): void {
  selectedRole.value = role ? JSON.parse(JSON.stringify(role)) : null;
  Object.assign(roleForm, {
    code: role?.code || '',
    name: role?.name || '',
    description: role?.description || '',
    scopes: [...(role?.scopes || [])],
  });
}
async function fetchData(): Promise<void> {
  const [accountData, roleData, events] = await Promise.all([
    canManageUsers.value
      ? apiRequest<{ items: User[] }>(
          `/v1/identity/admin/accounts?pageSize=100&q=${encodeURIComponent(search.value)}`,
        )
      : Promise.resolve({ items: [] }),
    canViewRoleDefinitions.value || canCreateAccounts.value
      ? apiRequest<{ items: Role[]; permissions: Permission[] }>(
          '/v1/identity/admin/roles',
        )
      : Promise.resolve({ items: [], permissions: [] }),
    canManageUsers.value
      ? apiRequest<{ items: SecurityEvent[] }>(
          '/v1/identity/admin/security-events?pageSize=20',
        )
      : Promise.resolve({ items: [] }),
  ]);
  accounts.value = accountData.items || [];
  roles.value = roleData.items || [];
  permissions.value = roleData.permissions || [];
  securityEvents.value = events.items || [];
}
async function load(): Promise<void> {
  await feedback.run(fetchData);
}
async function createAccount(): Promise<void> {
  if (!canCreateAccounts.value) return;
  await feedback.run(
    async () => {
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
          .filter((code) =>
            creatableRoles.value.some((role) => role.code === code),
          )
          .map((role) => ({ role }));
      let created: User;
      try {
        created = await myotaClient.createIdentityAccount<User>(payload);
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
      accountCreateForm.displayName = '';
      accountCreateForm.email = '';
      accountCreateForm.participationType = 'OPERATOR';
      accountCreateForm.callsign = '';
      accountCreateForm.roles = [];
      creatingAccount.value = false;
      await fetchData();
      return created;
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
        @submit.prevent="load"
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
    <p class="muted">Latest 20 events, in UTC.</p>
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
  </article>
</template>
