import { WorkerMetrics } from './worker-metrics.js';

describe('WorkerMetrics', () => {
  it('exposes bounded outcome, duration, and dependency metrics', () => {
    const metrics = new WorkerMetrics('activity-worker');
    metrics.setDependency('nats', true);
    metrics.setDependency('postgres', false);
    metrics.recordWork('activity.award-calculate.v1', 'completed', 0.25);
    metrics.recordWork('activity.award-calculate.v1', 'retried', 900);

    expect(metrics.render()).toContain(
      'myota_worker_work_total{service_id="activity-worker",work_type="activity.award-calculate.v1",outcome="completed"} 1',
    );
    expect(metrics.render()).toContain(
      'myota_worker_work_duration_seconds_bucket{service_id="activity-worker",work_type="activity.award-calculate.v1",le="0.5"} 1',
    );
    expect(metrics.render()).toContain(
      'myota_worker_work_duration_seconds_bucket{service_id="activity-worker",work_type="activity.award-calculate.v1",le="+Inf"} 2',
    );
    expect(metrics.render()).toContain(
      'myota_worker_dependency_up{service_id="activity-worker",dependency="nats"} 1',
    );
    expect(metrics.render()).toContain(
      'myota_worker_dependency_up{service_id="activity-worker",dependency="postgres"} 0',
    );
    expect(metrics.render()).toContain(
      'myota_worker_work_duration_seconds_sum{service_id="activity-worker",work_type="activity.award-calculate.v1"} 900.25',
    );
  });

  it('escapes labels and keeps lines sorted for stable scrapes', () => {
    const metrics = new WorkerMetrics('geodata"worker');
    metrics.recordWork('geodata.import\npreprocess.v1', 'dead_lettered', 1);

    const rendered = metrics.render();
    expect(rendered).toContain('service_id="geodata\\"worker"');
    expect(rendered).toContain('work_type="geodata.import\\npreprocess.v1"');
    expect(rendered.endsWith('\n')).toBe(true);
  });
});
