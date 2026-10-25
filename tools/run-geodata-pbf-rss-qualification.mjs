import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    'apps/geodata-worker/src/geodata-osm-pbf.spec.ts',
    '-t',
    'decodes',
    '--maxWorkers=1',
    '--no-file-parallelism',
    '--silent=false',
    '--disableConsoleIntercept',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      MYOTA_PBF_RSS_QUALIFICATION: '1',
    },
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
