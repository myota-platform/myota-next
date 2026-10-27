export type WorkerWorkOutcome =
  | 'completed'
  | 'failed'
  | 'retried'
  | 'dead_lettered'
  | 'not_claimed'
  | 'settlement_error';

const DURATION_BUCKETS = [0.1, 0.5, 1, 5, 30, 120, 600] as const;

type Duration = {
  buckets: number[];
  count: number;
  sum: number;
};

export class WorkerMetrics {
  private readonly outcomes = new Map<string, number>();
  private readonly durations = new Map<string, Duration>();
  private readonly dependencies = new Map<string, number>();

  constructor(private readonly serviceId: string) {}

  setDependency(name: 'nats' | 'postgres', connected: boolean): void {
    this.dependencies.set(name, connected ? 1 : 0);
  }

  recordWork(
    workType: string,
    outcome: WorkerWorkOutcome,
    durationSeconds: number,
  ): void {
    const key = JSON.stringify([workType, outcome]);
    this.outcomes.set(key, (this.outcomes.get(key) ?? 0) + 1);

    const duration = this.durations.get(workType) ?? {
      buckets: DURATION_BUCKETS.map(() => 0),
      count: 0,
      sum: 0,
    };
    const boundedDuration = Math.max(0, durationSeconds);
    DURATION_BUCKETS.forEach((bound, index) => {
      if (boundedDuration <= bound) duration.buckets[index] += 1;
    });
    duration.count += 1;
    duration.sum += boundedDuration;
    this.durations.set(workType, duration);
  }

  render(): string {
    const lines = [
      '# HELP myota_worker_work_total Work messages settled by bounded outcome.',
      '# TYPE myota_worker_work_total counter',
    ];
    for (const [key, count] of [...this.outcomes.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const [workType, outcome] = JSON.parse(key) as [string, string];
      lines.push(
        `myota_worker_work_total{service_id="${escapeLabel(this.serviceId)}",work_type="${escapeLabel(workType)}",outcome="${outcome}"} ${count}`,
      );
    }

    lines.push(
      '# HELP myota_worker_work_duration_seconds Work message settlement duration in seconds.',
      '# TYPE myota_worker_work_duration_seconds histogram',
    );
    for (const [workType, duration] of [...this.durations.entries()].sort(
      ([a], [b]) => a.localeCompare(b),
    )) {
      const labels = `service_id="${escapeLabel(this.serviceId)}",work_type="${escapeLabel(workType)}"`;
      DURATION_BUCKETS.forEach((bound, index) => {
        lines.push(
          `myota_worker_work_duration_seconds_bucket{${labels},le="${bound}"} ${duration.buckets[index]}`,
        );
      });
      lines.push(
        `myota_worker_work_duration_seconds_bucket{${labels},le="+Inf"} ${duration.count}`,
        `myota_worker_work_duration_seconds_sum{${labels}} ${duration.sum}`,
        `myota_worker_work_duration_seconds_count{${labels}} ${duration.count}`,
      );
    }

    lines.push(
      '# HELP myota_worker_dependency_up Whether the worker can reach a required dependency.',
      '# TYPE myota_worker_dependency_up gauge',
    );
    for (const [dependency, connected] of [...this.dependencies.entries()].sort(
      ([a], [b]) => a.localeCompare(b),
    )) {
      lines.push(
        `myota_worker_dependency_up{service_id="${escapeLabel(this.serviceId)}",dependency="${dependency}"} ${connected}`,
      );
    }
    return `${lines.join('\n')}\n`;
  }
}

function escapeLabel(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n');
}
