import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    'apps/geodata-worker/src/geodata-geojson-stream.spec.ts',
    '-t',
    'streams the Python 300,000-feature GeoJSON RSS workload',
    '--maxWorkers=1',
    '--no-file-parallelism',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      MYOTA_GEOJSON_RSS_QUALIFICATION: '1',
    },
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
