import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { restorePreviousCatalogRelease } from './myota-test-catalog-recovery.mjs';

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

function catalogContainsChartVersion(indexText, expectedVersion) {
  try {
    const parsedIndex = JSON.parse(indexText);
    const charts = parsedIndex?.entries?.[chartName];
    if (Array.isArray(charts))
      return charts.some((chart) => chart.version === expectedVersion);
  } catch {
    // Helm repositories serve YAML; Rancher's catalog API serializes it as JSON.
  }

  const escapedVersion = expectedVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:^|\\n)\\s*version:\\s*["']?${escapedVersion}["']?\\s*(?:\\r?\\n|$)`,
  ).test(indexText);
}

function releaseDeployments(list) {
  return new Map(
    (list.items ?? [])
      .filter(
        (deployment) =>
          deployment.metadata?.labels?.['app.kubernetes.io/instance'] ===
          releaseName,
      )
      .map((deployment) => [deployment.metadata.name, deployment]),
  );
}

function captureReadyRelease(list) {
  const deployments = releaseDeployments(list);
  if (deployments.size === 0)
    fail(
      'The existing release has no Deployments to use as a recovery baseline.',
    );

  const snapshot = {};
  for (const [name, deployment] of deployments) {
    const replicas = deployment.spec?.replicas ?? 1;
    const status = deployment.status ?? {};
    if (
      status.updatedReplicas !== replicas ||
      status.readyReplicas !== replicas ||
      status.availableReplicas !== replicas
    )
      fail(`Cannot capture recovery baseline: ${name} is not fully ready.`);
    const podSpec = deployment.spec?.template?.spec ?? {};
    const images = [
      ...(podSpec.containers ?? []),
      ...(podSpec.initContainers ?? []),
    ]
      .map((container) => container.image)
      .sort((left, right) => left.localeCompare(right));
    if (images.length === 0 || images.some((image) => !image))
      fail(
        `Cannot capture recovery baseline: ${name} has no complete image set.`,
      );
    snapshot[name] = { replicas, images };
  }
  return snapshot;
}

function releaseMatchesSnapshot(list, snapshot) {
  const actual = releaseDeployments(list);
  const expectedNames = Object.keys(snapshot).sort((left, right) =>
    left.localeCompare(right),
  );
  const actualNames = [...actual.keys()].sort((left, right) =>
    left.localeCompare(right),
  );
  if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames))
    return false;
  return expectedNames.every((name) => {
    const deployment = actual.get(name);
    const expected = snapshot[name];
    const replicas = expected.replicas;
    const podSpec = deployment.spec?.template?.spec ?? {};
    const images = [
      ...(podSpec.containers ?? []),
      ...(podSpec.initContainers ?? []),
    ]
      .map((container) => container.image)
      .sort((left, right) => left.localeCompare(right));
    const status = deployment.status ?? {};
    return (
      JSON.stringify(images) === JSON.stringify(expected.images) &&
      (deployment.spec?.replicas ?? 1) === replicas &&
      status.updatedReplicas === replicas &&
      status.readyReplicas === replicas &&
      status.availableReplicas === replicas
    );
  });
}

async function readReleaseValues(chartVersion) {
  const match = /^1\.1\.6-testing\.([0-9a-f]{12})\.1$/.exec(chartVersion);
  if (!match)
    fail(
      `Previous chart ${chartVersion} does not identify an immutable source commit.`,
    );
  const sourceUrl = new URL(
    'https://api.github.com/repos/myota-platform/myota-next/contents/deploy/fleet/myota-test/values.yaml',
  );
  sourceUrl.searchParams.set('ref', match[1]);
  const response = await fetch(sourceUrl, {
    redirect: 'error',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${process.env.MYOTA_TEST_GITHUB_TOKEN}`,
      'x-github-api-version': '2022-11-28',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    fail(
      `Could not retrieve the values for previous chart ${chartVersion} (HTTP ${response.status}).`,
    );
  const content = await response.json();
  if (content.encoding !== 'base64' || !content.content)
    fail(
      `GitHub did not return source values for previous chart ${chartVersion}.`,
    );
  const yamlText = Buffer.from(content.content, 'base64').toString('utf8');

  const python = process.env.MYOTA_TEST_PYTHON ?? 'python3';
  const parsed = spawnSync(
    python,
    [
      '-c',
      'import json,sys,yaml; json.dump(yaml.safe_load(sys.stdin.read()),sys.stdout)',
    ],
    { input: yamlText, encoding: 'utf8' },
  );
  if (parsed.error || parsed.status !== 0)
    fail(`Could not parse the values for previous chart ${chartVersion}.`);
  let values;
  try {
    values = JSON.parse(parsed.stdout);
  } catch {
    fail(`Could not decode the values for previous chart ${chartVersion}.`);
  }
  if (!values?.buildVersion?.startsWith('testing-') || !values?.images)
    fail(`Previous chart ${chartVersion} has incomplete testing values.`);
  for (const [name, image] of Object.entries(values.images)) {
    if (!/^sha256:[0-9a-f]{64}$/.test(image?.digest ?? ''))
      fail(`Previous chart ${chartVersion} has an unpinned ${name} image.`);
  }
  return values;
}

if (
  !apiBase ||
  !token ||
  !process.env.MYOTA_TEST_GITHUB_TOKEN ||
  !chartVersion ||
  !valuesPath ||
  !expectedPath
)
  fail(
    'Set the Rancher URL/token, GitHub token, and chart version; pass values and expected-deployments JSON paths.',
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

async function request(url, options = {}, allowNotFound = false) {
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
  if (!response.ok && !(allowNotFound && response.status === 404))
    fail(`Rancher returned HTTP ${response.status} for ${url.pathname}.`);
  return response;
}

async function getJson(url) {
  return (await request(url)).json();
}

async function getJsonIfPresent(url) {
  const response = await request(url, {}, true);
  return response.status === 404 ? null : response.json();
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
    if (state.failed) {
      const error = new Error(`${label} failed: ${state.description}`);
      error.safeToRollback = state.safeToRollback === true;
      throw error;
    }
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
    done: catalogContainsChartVersion(index, chartVersion),
    description: catalogContainsChartVersion(index, chartVersion)
      ? 'candidate chart is available'
      : 'candidate chart is not indexed yet',
  }),
);

const currentApp = await getJsonIfPresent(apiUrl(appPath));
const previousRevision = currentApp ? Number(currentApp.spec?.version) : 0;
if (!Number.isSafeInteger(previousRevision) || previousRevision < 0)
  fail('Rancher returned an invalid current Helm release revision.');
if (currentApp)
  console.log(`Upgrading current Rancher App revision ${previousRevision}.`);
else
  console.log(
    'Rancher App metadata is absent; the catalog upgrade will recreate it for the existing Helm release.',
  );
const deploymentListUrl = apiUrl(
  `/k8s/clusters/local/apis/apps/v1/namespaces/${namespace}/deployments`,
);
let previousRelease = null;
if (currentApp) {
  const previousChartVersion = currentApp.spec?.chart?.metadata?.version;
  if (!previousChartVersion)
    fail(
      'Rancher App metadata does not identify the prior chart needed for recovery.',
    );
  const previousValues = await readReleaseValues(previousChartVersion);
  const previousSnapshot = captureReadyRelease(
    await getJson(deploymentListUrl),
  );
  const catalogIndex = await (await request(indexUrl.index)).text();
  if (!catalogContainsChartVersion(catalogIndex, previousChartVersion))
    fail(
      `Previous chart ${previousChartVersion} is no longer available in the Rancher catalog; refusing an upgrade without a recovery chart.`,
    );
  previousRelease = {
    chartVersion: previousChartVersion,
    values: previousValues,
    revision: previousRevision,
    deployments: previousSnapshot,
  };
  console.log(
    `Captured recovery point: chart ${previousRelease.chartVersion}, revision ${previousRelease.revision}, ${Object.keys(previousSnapshot).length} ready Deployments.`,
  );
}

async function requestCatalogUpgrade(version, values) {
  const action = await request(apiUrl(`${repoPath}?action=upgrade`), {
    method: 'POST',
    body: JSON.stringify({
      namespace,
      install: true,
      wait: true,
      cleanupOnFail: true,
      historyMax: 10,
      charts: [{ chartName, version, releaseName, values }],
    }),
  });
  const actionResult = await action.json();
  if (!actionResult.operationName || !actionResult.operationNamespace)
    fail('Rancher did not return the catalog upgrade operation reference.');

  const operationUrl = apiUrl(
    `/v1/catalog.cattle.io.operations/${actionResult.operationNamespace}/${actionResult.operationName}`,
  );
  await waitFor(
    `Rancher Helm operation for chart ${version}`,
    () => getJson(operationUrl),
    (operation) => {
      const conditions = operation.status?.conditions ?? [];
      const ready = conditions.find((condition) => condition.type === 'Ready');
      const reconciling = conditions.find(
        (condition) => condition.type === 'Reconciling',
      );
      const stalled = conditions.find(
        (condition) => condition.type === 'Stalled',
      );
      const completed =
        ready?.status === 'True' ||
        (reconciling?.status === 'False' && stalled?.status === 'False');
      return {
        done: completed,
        failed: stalled?.status === 'True',
        safeToRollback: stalled?.status === 'True',
        description:
          stalled?.status === 'True'
            ? (stalled.reason ?? 'operation stalled')
            : completed
              ? 'operation completed'
              : 'operation is still running',
      };
    },
  );
}

async function verifyPreviousRelease() {
  await waitFor(
    'Previous Rancher App chart revision',
    () => getJson(apiUrl(appPath)),
    (app) => ({
      done:
        app.spec?.chart?.metadata?.version === previousRelease.chartVersion &&
        Number(app.spec?.version) > Number(previousRevision),
      description:
        app.spec?.chart?.metadata?.version === previousRelease.chartVersion
          ? 'previous chart version is restored'
          : 'waiting for the previous chart version',
    }),
  );
  await waitFor(
    'Previous Deployment image digest and readiness verification',
    async () => (await request(deploymentListUrl)).json(),
    (list) => ({
      done: releaseMatchesSnapshot(list, previousRelease.deployments),
      description: releaseMatchesSnapshot(list, previousRelease.deployments)
        ? 'previous Deployment images and readiness are restored'
        : 'waiting for previous Deployment images and readiness',
    }),
  );
}

let candidateOperationCompleted = false;
try {
  console.log(
    `Requesting Rancher catalog upgrade of ${releaseName} to chart ${chartVersion}.`,
  );
  await requestCatalogUpgrade(chartVersion, expectedValues);
  candidateOperationCompleted = true;

  await waitFor(
    'Rancher App chart revision',
    () => getJson(apiUrl(appPath)),
    (app) => ({
      done:
        app.spec?.chart?.metadata?.version === chartVersion &&
        Number(app.spec?.version) > Number(previousRevision),
      description:
        app.spec?.chart?.metadata?.version === chartVersion
          ? 'new chart revision is deployed'
          : 'waiting for Rancher App status to reflect the new chart revision',
    }),
  );

  await waitFor(
    'Deployment digest and readiness verification',
    async () => (await request(deploymentListUrl)).json(),
    (list) => {
      const actual = releaseDeployments(list);
      const expectedNames = Object.keys(expectedDeployments).sort(
        (left, right) => left.localeCompare(right),
      );
      const actualNames = [...actual.keys()].sort((left, right) =>
        left.localeCompare(right),
      );
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
          .sort((left, right) => left.localeCompare(right));
        const status = deployment.status ?? {};
        const ready =
          status.updatedReplicas === desiredReplicas &&
          status.readyReplicas === desiredReplicas &&
          status.availableReplicas === desiredReplicas;
        if (
          JSON.stringify(actualImages) !==
            JSON.stringify(
              [...expected.images].sort((left, right) =>
                left.localeCompare(right),
              ),
            ) ||
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
} catch (candidateError) {
  if (candidateOperationCompleted && candidateError instanceof Error)
    candidateError.safeToRollback = true;
  if (!previousRelease) {
    fail(
      `Test catalog upgrade failed: ${candidateError.message}. No prior healthy release recovery point was available; inspect the release before retrying.`,
    );
  }
  await restorePreviousCatalogRelease({
    candidateError,
    previousChartVersion: previousRelease.chartVersion,
    restore: async () => {
      console.log(
        `Restoring prior chart ${previousRelease.chartVersion} with its recorded values.`,
      );
      await requestCatalogUpgrade(
        previousRelease.chartVersion,
        previousRelease.values,
      );
      await verifyPreviousRelease();
    },
  });
}

console.log(
  `Rancher catalog upgrade verified: ${releaseName}, chart ${chartVersion}; ${Object.keys(expectedDeployments).length} Deployments ready at approved immutable image digests.`,
);
