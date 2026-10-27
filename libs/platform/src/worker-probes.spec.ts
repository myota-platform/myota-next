import { WorkerProbeServer } from './worker-probes.js';

describe('WorkerProbeServer', () => {
  it('serves the configured Prometheus metrics on its internal probe port', async () => {
    const probes = new WorkerProbeServer();
    const port = await probes.listen(
      0,
      async () => true,
      () => 'myota_worker_dependency_up 1\n',
      '127.0.0.1',
    );

    try {
      const response = await fetch(`http://127.0.0.1:${port}/metrics`);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain(
        'text/plain; version=0.0.4',
      );
      expect(await response.text()).toBe('myota_worker_dependency_up 1\n');
    } finally {
      await probes.close();
    }
  });

  it('keeps health and readiness probes separate from metrics', async () => {
    const probes = new WorkerProbeServer();
    const port = await probes.listen(
      0,
      async () => true,
      () => 'metrics\n',
      '127.0.0.1',
    );

    try {
      const [health, ready] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/healthz`),
        fetch(`http://127.0.0.1:${port}/readyz`),
      ]);
      expect(health.status).toBe(200);
      expect(ready.status).toBe(200);
      expect(await health.text()).toBe('ok\n');
      expect(await ready.text()).toBe('ready\n');
    } finally {
      await probes.close();
    }
  });
});
