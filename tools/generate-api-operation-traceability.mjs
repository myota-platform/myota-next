import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const contractLines = fs
  .readFileSync(path.join(repositoryRoot, 'contracts/openapi.yaml'), 'utf8')
  .split(/\r?\n/);
const verbs = new Set(['get', 'post', 'put', 'patch', 'delete']);
const contractOperations = [];
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
    contractOperations.push({
      method: methodMatch[1],
      path: currentPath,
      key: `${methodMatch[1]} ${currentPath}`,
    });
}

const controllers = [];
for (const entry of fs.readdirSync(path.join(repositoryRoot, 'apps'), {
  withFileTypes: true,
})) {
  if (!entry.isDirectory()) continue;
  const sourceRoot = path.join(repositoryRoot, 'apps', entry.name, 'src');
  if (!fs.existsSync(sourceRoot)) continue;
  for (const filename of fs.readdirSync(sourceRoot)) {
    if (!filename.endsWith('.controller.ts')) continue;
    const absolutePath = path.join(sourceRoot, filename);
    controllers.push({
      relativePath: path.relative(repositoryRoot, absolutePath),
      source: fs.readFileSync(absolutePath, 'utf8'),
    });
  }
}

const controllerOperations = new Map();
const decoratorVerbs = new Map([
  ['Get', 'get'],
  ['Post', 'post'],
  ['Put', 'put'],
  ['Patch', 'patch'],
  ['Delete', 'delete'],
]);

for (const controller of controllers) {
  const controllerMatch = controller.source.match(
    /@Controller\(\s*(?:(['"])(.*?)\1)?\s*\)/,
  );
  const prefix = controllerMatch?.[2] ?? '';
  const decorators =
    /@(Get|Post|Put|Patch|Delete)\(\s*(?:(['"])(.*?)\2)?\s*\)/g;

  for (const match of controller.source.matchAll(decorators)) {
    const route = [prefix, match[3] ?? '']
      .map((part) => part.replace(/^\/+|\/+$/g, ''))
      .filter(Boolean)
      .join('/');
    const openApiRoute = route.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const key = `${decoratorVerbs.get(match[1])} /v1${openApiRoute ? `/${openApiRoute}` : ''}`;
    const line = controller.source.slice(0, match.index).split('\n').length;
    const sources = controllerOperations.get(key) ?? [];
    sources.push({ path: controller.relativePath, line });
    controllerOperations.set(key, sources);
  }
}

const missing = contractOperations.filter(
  (operation) => !controllerOperations.has(operation.key),
);
if (missing.length) {
  process.stderr.write(
    `Cannot generate operation traceability; Nest routes are missing:\n${missing
      .map((operation) => `- ${operation.key}`)
      .join('\n')}\n`,
  );
  process.exitCode = 1;
} else {
  const rows = contractOperations.map((operation) => {
    const sourceLinks = controllerOperations
      .get(operation.key)
      .map(
        ({ path: sourcePath, line }) =>
          `[${sourcePath}#L${line}](../${sourcePath}#L${line})`,
      )
      .join('<br>');
    return `| \`${operation.method.toUpperCase()} ${operation.path}\` | ${sourceLinks} | Route mapped; behavior qualification is tracked in the parity matrix. |`;
  });
  const document = [
    '# API operation traceability',
    '',
    'This generated index maps each operation in `contracts/openapi.yaml` to its NestJS controller source. It is a navigation aid, not proof of request, response, authorization, persistence, or failure-behavior parity. Review those behaviors against the [function parity matrix](parity-matrix.md) and compatibility evidence before calling an operation complete.',
    '',
    'Regenerate with `npm run docs:api-traceability`. The mapping must cover every operation in the copied contract; target-only operations are documented separately in [API baseline notes](api-baseline.md).',
    '',
    `Contract baseline: [${contractOperations.length} operations](../contracts/openapi.yaml).`,
    '',
    '| OpenAPI operation | NestJS controller | Status |',
    '| --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
  const outputPath = path.join(
    repositoryRoot,
    'docs/api-operation-traceability.md',
  );
  const formatted = await format(document, { parser: 'markdown' });
  if (process.argv.includes('--check')) {
    if (
      !fs.existsSync(outputPath) ||
      fs.readFileSync(outputPath, 'utf8') !== formatted
    ) {
      process.stderr.write(
        'API operation traceability is stale; run npm run docs:api-traceability.\n',
      );
      process.exitCode = 1;
    } else {
      process.stdout.write(
        `API operation traceability covers ${contractOperations.length} OpenAPI operations.\n`,
      );
    }
  } else {
    fs.writeFileSync(outputPath, formatted);
    process.stdout.write(
      `Wrote controller mappings for ${contractOperations.length} OpenAPI operations.\n`,
    );
  }
}
