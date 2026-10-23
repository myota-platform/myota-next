import { ref } from 'vue';

export function usePageFeedback() {
  const loading = ref(false);
  const saving = ref(false);
  const error = ref('');
  const message = ref('');
  async function run<T>(
    work: () => Promise<T>,
    options: { success?: string; mutation?: boolean } = {},
  ): Promise<T | undefined> {
    const busy = options.mutation ? saving : loading;
    if (busy.value) return undefined;
    busy.value = true;
    error.value = '';
    message.value = '';
    try {
      const result = await work();
      if (options.success) message.value = options.success;
      return result;
    } catch (cause) {
      message.value = '';
      error.value =
        cause instanceof Error
          ? cause.message
          : 'The request could not be completed. Please retry.';
      return undefined;
    } finally {
      busy.value = false;
    }
  }
  return { loading, saving, error, message, run };
}
