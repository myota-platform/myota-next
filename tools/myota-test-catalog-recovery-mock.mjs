import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';

const priorDigest = `sha256:${'a'.repeat(64)}`;
const priorValues = {
  buildVersion: 'testing-prior',
  images: {
    gateway: {
      repository: 'ghcr.io/myota-platform/myota-next-gateway',
      digest: priorDigest,
    },
  },
};
const priorImage = `${priorValues.images.gateway.repository}@${priorDigest}`;
const candidateImage = `${priorValues.images.gateway.repository}@sha256:${'b'.repeat(64)}`;
const priorChartVersion = '1.1.6-testing.123456abcdef.1';
const candidateChartVersion = '1.1.6-testing.abcdef123456.1';
let upgradeCount = 0;
let appRevision = 47;
let restorationRequested = false;
let candidateStalled = false;

function record(event) {
  appendFileSync(
    process.env.MYOTA_TEST_MOCK_ACTION_LOG,
    `${JSON.stringify(event)}\n`,
  );
}

childProcess.spawnSync = () => ({
  error: undefined,
  status: 0,
  stdout: JSON.stringify(priorValues),
  stderr: '',
});
syncBuiltinESMExports();

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function priorDeployments() {
  const image =
    candidateStalled && !restorationRequested ? candidateImage : priorImage;
  const ready = image === priorImage;
  return {
    items: [
      {
        metadata: {
          name: 'myota-test-gateway',
          labels: { 'app.kubernetes.io/instance': 'myota-test' },
        },
        spec: {
          replicas: 1,
          template: { spec: { containers: [{ image }] } },
        },
        status: {
          updatedReplicas: ready ? 1 : 0,
          readyReplicas: ready ? 1 : 0,
          availableReplicas: ready ? 1 : 0,
        },
      },
    ],
  };
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input instanceof Request ? input.url : input);
  const method = options.method ?? 'GET';

  if (
    method === 'GET' &&
    url.pathname === '/v1/catalog.cattle.io.clusterrepos/myota-next-testing'
  )
    return response({
      links: { index: 'https://rancher.spainip.es/mock-index' },
    });

  if (method === 'GET' && url.pathname === '/mock-index')
    return response({
      entries: {
        'myota-next': [
          { version: candidateChartVersion },
          { version: priorChartVersion },
        ],
      },
    });

  if (
    method === 'GET' &&
    url.pathname === '/v1/catalog.cattle.io.apps/myota-test/myota-test'
  ) {
    record({ kind: 'app-read', afterRestore: restorationRequested });
    return response({
      spec: {
        chart: { metadata: { version: priorChartVersion } },
        version: appRevision,
      },
    });
  }

  if (
    method === 'GET' &&
    url.pathname ===
      '/k8s/clusters/local/apis/apps/v1/namespaces/myota-test/deployments'
  ) {
    const list = priorDeployments();
    record({
      kind: 'deployment-read',
      afterRestore: restorationRequested,
      image: list.items[0].spec.template.spec.containers[0].image,
      ready: list.items[0].status.readyReplicas === 1,
    });
    return response(list);
  }

  if (
    method === 'GET' &&
    url.pathname ===
      '/repos/myota-platform/myota-next/contents/deploy/fleet/myota-test/values.yaml'
  ) {
    if (url.searchParams.get('ref') !== '123456abcdef')
      return response({ message: 'unexpected source ref' }, 404);
    record({ kind: 'values-read', ref: url.searchParams.get('ref') });
    const sourceValues = [
      'buildVersion: testing-prior',
      'images:',
      '  gateway:',
      '    repository: ghcr.io/myota-platform/myota-next-gateway',
      `    digest: ${priorDigest}`,
      '',
    ].join('\n');
    return response({
      encoding: 'base64',
      content: Buffer.from(sourceValues).toString('base64'),
    });
  }

  if (
    method === 'POST' &&
    url.pathname === '/v1/catalog.cattle.io.clusterrepos/myota-next-testing'
  ) {
    const payload = JSON.parse(options.body);
    const chart = payload.charts[0];
    upgradeCount += 1;
    record({ kind: 'upgrade', version: chart.version, values: chart.values });
    if (upgradeCount === 2) {
      restorationRequested = true;
      appRevision += 1;
    }
    return response({
      operationNamespace: 'default',
      operationName: upgradeCount === 1 ? 'candidate' : 'restore',
    });
  }

  if (
    method === 'GET' &&
    url.pathname === '/v1/catalog.cattle.io.operations/default/candidate'
  ) {
    candidateStalled = true;
    return response({
      status: {
        conditions: [
          { type: 'Stalled', status: 'True', reason: 'TestFailure' },
          { type: 'Ready', status: 'False' },
          { type: 'Reconciling', status: 'False' },
        ],
      },
    });
  }

  if (
    method === 'GET' &&
    url.pathname === '/v1/catalog.cattle.io.operations/default/restore'
  )
    return response({
      status: {
        conditions: [
          { type: 'Stalled', status: 'False' },
          { type: 'Ready', status: 'True' },
          { type: 'Reconciling', status: 'False' },
        ],
      },
    });

  const error = new Error(
    `Unexpected mocked Rancher request: ${method} ${url}`,
  );
  error.cause = { method, url: url.toString() };
  throw error;
};
