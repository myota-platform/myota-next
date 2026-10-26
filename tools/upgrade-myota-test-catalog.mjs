import { readFile } from 'node:fs/promises';

const rancherHost = 'rancher.spainip.es';
const apiBase = process.env.MYOTA_TEST_RANCHER_URL;
const token = process.env.MYOTA_TEST_RANCHER_TOKEN;
const chartVersion = process.env.MYOTA_TEST_CHART_VERSION;
const valuesPath = process.argv[2];
const expectedPath = process.argv[3];
const repository = 'myota-next-testing';
const namespace = 'myota-test';
const releaseName = 'myota-test';
const chartName = 'myota-next';
const timeoutMs = 30 * 60 * 1000;
const pollMs = 10 * 1000;

function fail(message) {
  throw new Error(message);
}

function catalogContainsChartVersion(indexText) {
  try {
    const parsedIndex = JSON.parse(indexText);
    const charts = parsedIndex?.entries?.[chartName];
    if (Array.isArray(charts))
      return charts.some((chart) => chart.version === chartVersion);
  } catch {
    // Helm repositories serve YAML; Rancher's catalog API serializes it as JSON.
  }

  const escapedVersion = chartVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:^|\\n)\\s*version:\\s*["']?${escapedVersion}["']?\\s*(?:\\r?\\n|$)`,
  ).test(indexText);
}

if (!apiBase || !token || !chartVersion || !valuesPath || !expectedPath)
  fail(
    'Set MYOTA_TEST_RANCHER_URL, MYOTA_TEST_RANCHER_TOKEN, MYOTA_TEST_CHART_VERSION, and pass values and expected-deployments JSON paths.',
  );

const rancherUrl = new URL(apiBase);
if (
  rancherUrl.protocol !== 'https:' ||
  rancherUrl.hostname !== rancherHost ||
  rancherUrl.pathname !== '/' ||
  rancherUrl.search ||
  rancherUrl.hash
)
  fail(`MYOTA_TEST_RANCHER_URL must be https://${rancherHost}/`);

const candidatePattern = /^1\.1\.6-testing\.[0-9a-f]{12}\.1$/;
if (!candidatePattern.test(chartVersion))
  fail(
    'MYOTA_TEST_CHART_VERSION is not a valid immutable testing chart version.',
  );

const expectedValues = JSON.parse(await readFile(valuesPath, 'utf8'));
const expectedDeployments = JSON.parse(await readFile(expectedPath, 'utf8'));
if (!expectedValues.buildVersion || !expectedValues.images)
  fail('Deployment values must include buildVersion and images.');
if (!expectedDeployments || Object.keys(expectedDeployments).length === 0)
  fail('The rendered chart contains no expected deployments.');

const apiUrl = (path) => new URL(path, rancherUrl);

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: 'error',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    fail(`Rancher returned HTTP ${response.status} for ${url.pathname}.`);
  return response;
}

async function getJson(url) {
  return (await request(url)).json();
}

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(label, operation, predicate) {
  const deadline = Date.now() + timeoutMs;
  let lastState = 'not observed';
  while (Date.now() < deadline) {
    let result;
    try {
      result = await operation();
    } catch (error) {
      lastState = error?.message ?? 'request failed';
      if (/^Rancher returned HTTP (?!404|408|429|5\d\d)/.test(lastState))
        throw error;
      console.log(`${label}: ${lastState}; retrying.`);
      await sleep(pollMs);
      continue;
    }
    const state = predicate(result);
    if (state.done) return result;
    if (state.failed) fail(`${label} failed: ${state.description}`);
    lastState = state.description;
    console.log(`${label}: ${lastState}; retrying.`);
    await sleep(pollMs);
  }
  fail(`${label} did not complete within 30 minutes; last state: ${lastState}`);
}

const repoPath = `/v1/catalog.cattle.io.clusterrepos/${repository}`;
const appPath = `/v1/catalog.cattle.io.apps/${namespace}/${releaseName}`;
const indexUrl = await waitFor(
  'Rancher catalog repository',
  async () => {
    const repo = await getJson(apiUrl(repoPath));
    const link = repo.links?.index;
    if (!link) return { index: null };
    const url = new URL(link);
    if (url.origin !== rancherUrl.origin)
      fail('Rancher returned a chart index URL outside its own origin.');
    return { index: url.toString() };
  },
  (result) => ({
    done: Boolean(result.index),
    description: result.index
      ? 'index link is ready'
      : 'index link unavailable',
  }),
);

await waitFor(
  `Chart ${chartVersion} in the Rancher catalog index`,
  async () => {
    const response = await request(indexUrl.index, {
      headers: { accept: 'application/yaml, text/yaml, */*' },
    });
    return response.text();
  },
  (index) => ({
    done: catalogContainsChartVersion(index),
    description: catalogContainsChartVersion(index)
      ? 'candidate chart is available'
      : 'candidate chart is not indexed yet',
  }),
);

const desiredApp = await waitFor(
  'Fleet desired App values',
  () => getJson(apiUrl(appPath)),
  (app) => {
    const values = app.spec?.values;
    const expectedImageNames = Object.keys(expectedValues.images ?? {}).sort();
    const actualImageNames = Object.keys(values?.images ?? {}).sort();
    const imagesMatch =
      JSON.stringify(expectedImageNames) === JSON.stringify(actualImageNames) &&
      expectedImageNames.every(
        (name) =>
          values.images[name]?.repository ===
            expectedValues.images[name]?.repository &&
          values.images[name]?.digest === expectedValues.images[name]?.digest,
      );
    const valuesMatch =
      values?.buildVersion === expectedValues.buildVersion && imagesMatch;
    return {
      done: valuesMatch,
      description: valuesMatch
        ? 'approved build and image digests are reconciled'
        : 'waiting for Fleet to apply the approved build and image digests',
    };
  },
);

const previousRevision = desiredApp.spec.version;
console.log(
  `Requesting Rancher catalog upgrade of ${releaseName} to chart ${chartVersion}.`,
);
const action = await request(apiUrl(`${repoPath}?action=upgrade`), {
  method: 'POST',
  body: JSON.stringify({
    namespace,
    install: true,
    wait: true,
    cleanupOnFail: true,
    historyMax: 10,
    charts: [
      {
        chartName,
        version: chartVersion,
        releaseName,
        values: desiredApp.spec.values,
      },
    ],
  }),
});
const actionResult = await action.json();
const operationName = actionResult.operationName;
const operationNamespace = actionResult.operationNamespace;
if (!operationName || !operationNamespace)
  fail('Rancher did not return the catalog upgrade operation reference.');

const operationUrl = apiUrl(
  `/v1/catalog.cattle.io.operations/${operationNamespace}/${operationName}`,
);
await waitFor(
  'Rancher Helm operation',
  () => getJson(operationUrl),
  (operation) => {
    const conditions = operation.status?.conditions ?? [];
    const ready = conditions.find((condition) => condition.type === 'Ready');
    const stalled = conditions.find(
      (condition) => condition.type === 'Stalled',
    );
    return {
      done: ready?.status === 'True',
      failed: stalled?.status === 'True',
      description:
        stalled?.status === 'True'
          ? (stalled.reason ?? 'operation stalled')
          : ready?.status === 'True'
            ? 'upgrade completed'
            : 'operation is still running',
    };
  },
);

await waitFor(
  'Rancher App chart revision',
  () => getJson(apiUrl(appPath)),
  (app) => ({
    done:
      app.spec?.chart?.metadata?.version === chartVersion &&
      Number(app.spec?.version) > Number(previousRevision),
    description:
      app.spec?.chart?.metadata?.version === chartVersion &&
      Number(app.spec?.version) > Number(previousRevision)
        ? 'new chart revision is deployed'
        : 'waiting for Rancher App status to reflect the new chart revision',
  }),
);

const deploymentListUrl = apiUrl(
  `/k8s/clusters/local/apis/apps/v1/namespaces/${namespace}/deployments`,
);
await waitFor(
  'Deployment digest and readiness verification',
  async () => {
    const response = await request(deploymentListUrl);
    return response.json();
  },
  (list) => {
    const actual = new Map(
      (list.items ?? [])
        .filter(
          (deployment) =>
            deployment.metadata?.labels?.['app.kubernetes.io/instance'] ===
            releaseName,
        )
        .map((deployment) => [deployment.metadata.name, deployment]),
    );
    const expectedNames = Object.keys(expectedDeployments).sort();
    const actualNames = [...actual.keys()].sort();
    if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames))
      return {
        done: false,
        description: 'waiting for the expected Deployment set',
      };

    for (const name of expectedNames) {
      const deployment = actual.get(name);
      const expected = expectedDeployments[name];
      const desiredReplicas = expected.replicas;
      const podSpec = deployment.spec?.template?.spec ?? {};
      const actualImages = [
        ...(podSpec.containers ?? []),
        ...(podSpec.initContainers ?? []),
      ]
        .map((container) => container.image)
        .sort();
      const ready =
        deployment.status?.updatedReplicas === desiredReplicas &&
        deployment.status?.readyReplicas === desiredReplicas &&
        deployment.status?.availableReplicas === desiredReplicas;
      if (
        JSON.stringify(actualImages) !==
          JSON.stringify([...expected.images].sort()) ||
        !ready
      )
        return {
          done: false,
          description: `${name} is not yet ready at the approved image digest`,
        };
    }
    return {
      done: true,
      description: `${expectedNames.length} Deployments use the approved digests and are ready`,
    };
  },
);

console.log(
  `Rancher catalog upgrade verified: ${releaseName}, chart ${chartVersion}; ${Object.keys(expectedDeployments).length} Deployments ready at approved immutable image digests.`,
);
