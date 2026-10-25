import { spawnSync } from 'node:child_process';

const commonArguments = [
  'node_modules/vitest/vitest.mjs',
  'run',
  '--maxWorkers=1',
  '--no-file-parallelism',
  '--silent=false',
  '--disableConsoleIntercept',
  '--reporter=verbose',
];
const qualifications = [
  {
    file: 'apps/geodata-worker/src/geodata-geojson-stream.spec.ts',
    test: 'streams the Python 300,000-feature GeoJSON RSS workload',
    environment: { MYOTA_GEOJSON_RSS_QUALIFICATION: '1' },
  },
  {
    file: 'apps/geodata-worker/src/geodata-xml-stream.spec.ts',
    test: 'streams the Python 50,000-feature KML and GPX workloads',
  },
  {
    file: 'apps/geodata-worker/src/geodata-shapefile-stream.spec.ts',
    test: 'streams the Python 50,000-record Shapefile RSS workload',
  },
];

for (const qualification of qualifications) {
  const result = spawnSync(
    process.execPath,
    [...commonArguments, qualification.file, '-t', qualification.test],
    {
      stdio: 'inherit',
      env: { ...process.env, ...qualification.environment },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
