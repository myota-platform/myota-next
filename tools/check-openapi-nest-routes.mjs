import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const contractPath = path.join(repositoryRoot, 'contracts/openapi.yaml');
const contractLines = fs.readFileSync(contractPath, 'utf8').split(/\r?\n/);
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
    contractOperations.add(`${methodMatch[1]} ${currentPath}`);
}

const nestOperations = new Set();
const controllerFiles = [];
for (const entry of fs.readdirSync(path.join(repositoryRoot, 'apps'), {
  withFileTypes: true,
})) {
  if (!entry.isDirectory()) continue;
  const sourceRoot = path.join(repositoryRoot, 'apps', entry.name, 'src');
  if (!fs.existsSync(sourceRoot)) continue;
  for (const filename of fs.readdirSync(sourceRoot))
    if (filename.endsWith('.controller.ts'))
      controllerFiles.push(path.join(sourceRoot, filename));
}

const decoratorVerbs = new Map([
  ['Get', 'get'],
  ['Post', 'post'],
  ['Put', 'put'],
  ['Patch', 'patch'],
  ['Delete', 'delete'],
]);

for (const controllerPath of controllerFiles) {
  const source = fs.readFileSync(controllerPath, 'utf8');
  const controllerMatch = source.match(/@Controller\(\s*(['"])(.*?)\1\s*\)/);
  const prefix = controllerMatch?.[2] ?? '';
  const decorators =
    /@(Get|Post|Put|Patch|Delete)\(\s*(?:(['"])(.*?)\2)?\s*\)/g;

  for (const match of source.matchAll(decorators)) {
    const route = [prefix, match[3] ?? '']
      .map((part) => part.replace(/^\/+|\/+$/g, ''))
      .filter(Boolean)
      .join('/');
    const openApiRoute = route.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    nestOperations.add(
      `${decoratorVerbs.get(match[1])} /v1${openApiRoute ? `/${openApiRoute}` : ''}`,
    );
  }
}

const missing = [...contractOperations]
  .filter((operation) => !nestOperations.has(operation))
  .sort((left, right) => left.localeCompare(right));

if (!contractOperations.size)
  missing.push('OpenAPI contract has no recognized path operations');

if (missing.length) {
  process.stderr.write(
    `NestJS controllers are missing OpenAPI operations:\n${missing
      .map((operation) => `- ${operation}`)
      .join('\n')}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `NestJS controller routes cover all ${contractOperations.size} OpenAPI operations.\n`,
  );
}
