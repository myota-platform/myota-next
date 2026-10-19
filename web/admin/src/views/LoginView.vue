<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAppStore } from '../stores/app';

const store = useAppStore();
const router = useRouter();
const route = useRoute();
const email = ref('');
const password = ref('');
const error = ref('');
const submitting = ref(false);

async function submit(): Promise<void> {
  submitting.value = true;
  error.value = '';
  try {
    await store.signIn(email.value, password.value);
    await router.replace(String(route.query.redirect || '/dashboard'));
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Unable to sign in.';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <main class="login-shell">
    <section class="login-card">
      <p class="eyebrow">MYOTA PLATFORM</p>
      <h1>Administration</h1>
      <p class="muted">
        Manage programmes, identity, geodata reviews and operational activity.
      </p>
      <form @submit.prevent="submit">
        <label
          >Email<input
            v-model="email"
            type="email"
            autocomplete="username"
            required
        /></label>
        <label
          >Password<input
            v-model="password"
            type="password"
            autocomplete="current-password"
            required
        /></label>
        <button class="primary" :disabled="submitting" type="submit">
          {{ submitting ? 'Signing in…' : 'Sign in' }}
        </button>
      </form>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p class="hint">
        Administrator access is controlled by the identity service.
      </p>
    </section>
  </main>
</template>
