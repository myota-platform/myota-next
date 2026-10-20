import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const nestCli = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, 'nest-cli.json'), 'utf8'),
);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
);
const errors = [];
const serviceIds = new Map();

if (!packageJson.dependencies?.['@nestjs/observe'])
  errors.push('@nestjs/observe must be a direct runtime dependency');

const bootstrapPath = path.join(
  repositoryRoot,
  'libs/platform/src/bootstrap.ts',
);
const bootstrapSource = fs.readFileSync(bootstrapPath, 'utf8');
if (
  !bootstrapSource.includes("from './observe.js'") ||
  !/instrument:\s*ObserveInstrument/.test(bootstrapSource)
)
  errors.push('shared HTTP bootstrap must enable ObserveInstrument');

const applications = Object.entries(nestCli.projects || {}).filter(
  ([, project]) => project.type === 'application',
);
if (!applications.length) errors.push('Nest CLI has no application projects');

for (const [name, project] of applications) {
  const mainPath = path.join(
    repositoryRoot,
    project.sourceRoot,
    `${project.entryFile || 'main'}.ts`,
  );
  if (!fs.existsSync(mainPath)) {
    errors.push(
      `${name}: missing process entry ${path.relative(repositoryRoot, mainPath)}`,
    );
    continue;
  }
  const mainSource = fs.readFileSync(mainPath, 'utf8');
  const moduleImports = [
    ...mainSource.matchAll(/import\s*\{([^}]+)\}\s*from\s*(['"])([^'"]+)\2/g),
  ].flatMap((match) =>
    match[1]
      .split(',')
      .map((binding) => binding.trim().split(/\s+as\s+/)[0])
      .filter((name) => name.endsWith('Module'))
      .map((name) => ({ name, source: match[3] })),
  );
  const rootModuleImport = moduleImports.find((match) =>
    match.source.startsWith('.'),
  );
  if (!rootModuleImport) {
    errors.push(
      `${name}: could not identify the process root module from main.ts`,
    );
    continue;
  }

  const rootModulePath = path.resolve(
    path.dirname(mainPath),
    rootModuleImport.source.replace(/\.js$/, '') + '.ts',
  );
  if (!fs.existsSync(rootModulePath)) {
    errors.push(`${name}: root module file is missing`);
    continue;
  }
  const moduleSource = fs.readFileSync(rootModulePath, 'utf8');
  if (
    !/import\s*\{[^}]*\bobserveRoot\b[^}]*\}\s*from\s*['"]@app\/platform['"]/s.test(
      moduleSource,
    ) ||
    !/imports\s*:\s*\[[\s\S]*?observeRoot\s*\(/.test(moduleSource)
  ) {
    errors.push(
      `${name}: root module must import observeRoot from @app/platform`,
    );
    continue;
  }

  const ids = [
    ...moduleSource.matchAll(/observeRoot\s*\(\s*(['"])([^'"]+)\1\s*\)/g),
  ].map((match) => match[2]);
  if (ids.length !== 1) {
    errors.push(`${name}: expected exactly one literal observeRoot service ID`);
    continue;
  }
  if (serviceIds.has(ids[0]))
    errors.push(
      `${name}: Observe service ID '${ids[0]}' is also used by ${serviceIds.get(ids[0])}`,
    );
  else serviceIds.set(ids[0], name);

  const usesSharedHttpBootstrap = /\bbootstrapHttpService\s*\(/.test(
    mainSource,
  );
  const enablesObserveDirectly = /\binstrument:\s*ObserveInstrument\b/.test(
    mainSource,
  );
  if (!usesSharedHttpBootstrap && !enablesObserveDirectly)
    errors.push(`${name}: process entry must enable ObserveInstrument`);
}

if (errors.length) {
  process.stderr.write(`${errors.map((error) => `- ${error}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Observability wiring verified for ${applications.length} NestJS applications.\n`,
  );
}
