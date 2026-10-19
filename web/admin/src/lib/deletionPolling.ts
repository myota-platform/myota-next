export interface DeletionJobState {
  id: string;
  status?: string;
}

export const pendingDeletionStatuses = new Set(['QUEUED', 'PROCESSING']);

interface PollDeletionJobsOptions<T, J extends DeletionJobState> {
  items: T[];
  jobFor: (item: T) => J;
  refresh: (jobId: string) => Promise<J>;
  update: (item: T, job: J) => void;
  onError: (item: T, error: unknown) => void;
  pause: () => Promise<void>;
  batchSize?: number;
}

/** Poll pending jobs until each reaches a terminal state; errors are retried. */
export async function pollDeletionJobs<T, J extends DeletionJobState>({
  items,
  jobFor,
  refresh,
  update,
  onError,
  pause,
  batchSize = 10,
}: PollDeletionJobsOptions<T, J>): Promise<void> {
  while (
    items.some((item) =>
      pendingDeletionStatuses.has(String(jobFor(item).status).toUpperCase()),
    )
  ) {
    const active = items.filter((item) =>
      pendingDeletionStatuses.has(String(jobFor(item).status).toUpperCase()),
    );

    for (let offset = 0; offset < active.length; offset += batchSize) {
      const batch = active.slice(offset, offset + batchSize);
      const results = await Promise.allSettled(
        batch.map((item) => refresh(jobFor(item).id)),
      );
      results.forEach((result, index) => {
        const item = batch[index];
        if (result.status === 'fulfilled') {
          update(item, result.value);
        } else {
          onError(item, result.reason);
        }
      });
    }

    if (
      items.some((item) =>
        pendingDeletionStatuses.has(String(jobFor(item).status).toUpperCase()),
      )
    ) {
      await pause();
    }
  }
}
