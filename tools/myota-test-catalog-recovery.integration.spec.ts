import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(repositoryRoot, 'tools/upgrade-myota-test-catalog.mjs');
const mockPath = join(
  repositoryRoot,
  'tools/myota-test-catalog-recovery-mock.mjs',
);
const priorDigest = `sha256:${'a'.repeat(64)}`;
const priorImage = `ghcr.io/myota-platform/myota-next-gateway@${priorDigest}`;

describe('myota-test catalog failure recovery integration', () => {
  it('restores the recorded prior chart and verifies the prior Deployment after Rancher stalls', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'myota-catalog-recovery-'));
    try {
      const valuesPath = join(directory, 'candidate-values.json');
      const expectedPath = join(directory, 'candidate-deployments.json');
      const actionLogPath = join(directory, 'catalog-actions.jsonl');
      await writeFile(
        valuesPath,
        JSON.stringify({
          buildVersion: 'testing-candidate',
          images: {
            gateway: {
              repository: 'ghcr.io/myota-platform/myota-next-gateway',
              digest: `sha256:${'b'.repeat(64)}`,
            },
            'participant-web': {
              repository: 'ghcr.io/myota-platform/myota-next-participant-web',
              digest: `sha256:${'c'.repeat(64)}`,
            },
          },
        }),
      );
      await writeFile(
        expectedPath,
        JSON.stringify({
          'myota-test-gateway': {
            replicas: 1,
            images: [
              `ghcr.io/myota-platform/myota-next-gateway@sha256:${'b'.repeat(64)}`,
            ],
          },
        }),
      );

      const result = spawnSync(
        process.execPath,
        ['--import', mockPath, scriptPath, valuesPath, expectedPath],
        {
          encoding: 'utf8',
          timeout: 10_000,
          env: {
            ...process.env,
            MYOTA_TEST_SIMULATE_RECOVERY_FAILURE: 'true',
            MYOTA_TEST_RANCHER_URL: 'https://rancher.spainip.es/',
            MYOTA_TEST_RANCHER_TOKEN: 'mock-rancher-token',
            MYOTA_TEST_GITHUB_TOKEN: 'mock-github-token',
            MYOTA_TEST_CHART_VERSION: '1.1.6-testing.abcdef123456.56',
            MYOTA_TEST_PYTHON: 'mock-yaml-parser',
            MYOTA_TEST_MOCK_ACTION_LOG: actionLogPath,
          },
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('Restoring prior chart');
      expect(result.stdout).toContain(
        'using a deliberately nonexistent participant-web image digest',
      );
      expect(result.stderr).toContain(
        'Previous chart 1.1.6-testing.123456abcdef.1 and its approved image digests were restored and verified',
      );

      const actions = (await readFile(actionLogPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const upgrades = actions.filter((action) => action.kind === 'upgrade');
      expect(upgrades).toHaveLength(2);
      expect(upgrades[0].version).toBe('1.1.6-testing.abcdef123456.56');
      expect(upgrades[0].values.images['participant-web'].digest).toBe(
        `sha256:${'0'.repeat(64)}`,
      );
      expect(upgrades[1]).toEqual({
        kind: 'upgrade',
        version: '1.1.6-testing.123456abcdef.1',
        values: {
          buildVersion: 'testing-prior',
          images: {
            gateway: {
              repository: 'ghcr.io/myota-platform/myota-next-gateway',
              digest: priorDigest,
            },
          },
        },
      });
      expect(
        actions.some(
          (action) =>
            action.kind === 'values-read' && action.ref === '123456abcdef',
        ),
      ).toBe(true);
      expect(
        actions.some(
          (action) =>
            action.kind === 'app-read' && action.afterRestore === true,
        ),
      ).toBe(true);
      expect(
        actions.some(
          (action) =>
            action.kind === 'deployment-read' &&
            action.afterRestore === true &&
            action.image === priorImage &&
            action.ready === true,
        ),
      ).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
