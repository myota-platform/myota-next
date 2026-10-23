import type { UploadRequest } from './geodataUploads';

export interface ImportRun {
  id: string;
  filename?: string;
  format?: string;
  adapter?: string;
  status?: string;
  source?: string | Record<string, unknown>;
  featureCount?: number;
  candidateCounts?: {
    total?: number;
    pending?: number;
    confirmed?: number;
    processed?: number;
    duplicates?: number;
  };
  stats?: Record<string, unknown>;
  errors?: unknown[];
  lastError?: string;
  queuedAt?: string;
  startedAt?: string;
  completedAt?: string;
  processedAt?: string;
  heartbeatAt?: string;
  attemptCount?: number;
  binaryObjectPending?: boolean;
  // Compatibility fields from older service versions.
  entityCount?: number;
  processedCount?: number;
  candidateCount?: number;
  errorCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface ImportPage {
  items: ImportRun[];
  total?: number;
  nextPage?: number | null;
}

export function isPreprocessing(run: ImportRun): boolean {
  return ['UPLOAD_PENDING', 'QUEUED', 'PROCESSING', 'CANCELLING'].includes(
    run.status || '',
  );
}

export function canCancelPreprocessing(run: ImportRun): boolean {
  return ['UPLOAD_PENDING', 'QUEUED', 'PROCESSING'].includes(run.status || '');
}

export function isReviewable(run: ImportRun): boolean {
  return ['PREPROCESSED', 'PREPROCESSED_WITH_ERRORS'].includes(
    run.status || '',
  );
}

export function importStatusLabel(run: ImportRun): string {
  const labels: Record<string, string> = {
    UPLOAD_PENDING: 'Waiting for upload',
    QUEUED: 'Waiting to preprocess',
    PROCESSING: 'Preprocessing',
    CANCELLING: 'Cancelling…',
    CANCELLED: 'Cancelled',
    PREPROCESSED: 'Ready to review',
    PREPROCESSED_WITH_ERRORS: 'Ready with errors',
    COMPLETED: 'Promotion completed',
    COMPLETED_WITH_ERRORS: 'Completed with errors',
    PROCESSED: 'Finalized',
    FAILED: 'Failed',
    REJECTED: 'Rejected',
  };
  return labels[run.status || ''] || run.status || 'Unknown';
}

function count(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? Math.max(0, result) : 0;
}

export function importCounts(run: ImportRun): {
  source: number;
  pending: number;
  confirmed: number;
  promoted: number;
  errors: number;
  duplicates: number;
} {
  const stats = run.stats || {};
  return {
    source: count(
      run.featureCount ??
        run.entityCount ??
        count(stats.preprocessed) + count(stats.errors),
    ),
    pending: count(run.candidateCounts?.pending ?? run.candidateCount),
    confirmed: count(run.candidateCounts?.confirmed),
    promoted: count(
      run.processedCount ?? count(stats.created) + count(stats.updated),
    ),
    errors:
      count(run.errorCount ?? stats.errors) + count(stats.processingErrors),
    duplicates: count(run.candidateCounts?.duplicates),
  };
}

export async function fetchPreprocessingQueue(
  request: UploadRequest,
): Promise<ImportRun[]> {
  const runs: ImportRun[] = [];
  let page = 1;
  while (true) {
    const result = await request<ImportPage>(
      `/v1/geodata/imports?page=${page}&pageSize=100`,
    );
    runs.push(
      ...result.items.filter(
        (run) => isPreprocessing(run) || isReviewable(run),
      ),
    );
    if (!result.nextPage || result.nextPage <= page) break;
    page = result.nextPage;
  }
  return runs;
}
