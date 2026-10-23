import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const contractPath = path.join(repositoryRoot, 'contracts/openapi.yaml');
const gatewayPath = path.join(
  repositoryRoot,
  'apps/gateway/src/gateway.controller.ts',
);
const traceabilityPath = path.join(
  repositoryRoot,
  'docs/api-operation-traceability.md',
);
const contractLines = fs.readFileSync(contractPath, 'utf8').split(/\r?\n/);
const routeRows = fs
  .readFileSync(gatewayPath, 'utf8')
  .match(/const ROUTES:[\s\S]*?= \[([\s\S]*?)\n\];/)?.[1]
  ?.matchAll(/\[['"]([^'"]+)['"],\s*['"]([A-Z]+)['"]\]/g);
const routes = routeRows
  ? [...routeRows].map(([, prefix, service]) => ({ prefix, service }))
  : [];
const contractOperations = new Set();
const verbs = new Set(['get', 'post', 'put', 'patch', 'delete']);
let currentPath;
let inPaths = false;

for (const line of contractLines) {
  if (/^paths:\s*$/.test(line)) {
    inPaths = true;
    continue;
  }
  if (inPaths && /^\S/.test(line)) break;
  if (!inPaths) continue;

  const pathMatch = line.match(/^  (\/[^:]+):\s*$/);
  if (pathMatch) {
    currentPath = pathMatch[1];
    continue;
  }
  const methodMatch = line.match(/^    ([a-z]+):\s*$/);
  if (currentPath && methodMatch && verbs.has(methodMatch[1]))
    contractOperations.add(`${methodMatch[1].toUpperCase()} ${currentPath}`);
}

const appServices = new Map([
  ['identity', 'IDENTITY'],
  ['programmes', 'PROGRAMMES'],
  ['activity', 'ACTIVITY'],
  ['geodata', 'GEODATA'],
]);
const traceabilityLines = fs
  .readFileSync(traceabilityPath, 'utf8')
  .split(/\r?\n/);
const operations = traceabilityLines.flatMap((line) => {
  const match = line.match(
    /^- `([A-Z]+) (\/[^`]+)` — \[[^\]]+\]\(\.\.\/apps\/([^/]+)\/src\//,
  );
  if (!match) return [];
  const service = appServices.get(match[3]);
  return service ? [{ operation: `${match[1]} ${match[2]}`, service }] : [];
});
const uncovered = [...contractOperations]
  .filter((operation) => {
    const mapped = operations.find((item) => item.operation === operation);
    const [, path] = operation.split(' ', 2);
    const selected = routes.find((route) => path.startsWith(route.prefix));
    return !mapped || selected?.service !== mapped.service;
  })
  .sort((left, right) => left.localeCompare(right));

if (uncovered.length || !routes.length) {
  process.stderr.write(
    `Gateway routes do not reach the owning service for OpenAPI operations:\n${[
      ...uncovered.map((route) => `- ${route}`),
      ...(!routes.length ? ['- Gateway route table could not be read'] : []),
    ].join('\n')}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Gateway routes reach the owning service for all ${contractOperations.size} OpenAPI operations.\n`,
  );
}
