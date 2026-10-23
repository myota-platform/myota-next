import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const errors = [];
const expectedDatabaseByApplication = {
  gateway: null,
  identity: 'CORE_DATABASE_URL',
  'identity-maintenance': 'CORE_DATABASE_URL',
  programmes: 'CORE_DATABASE_URL',
  activity: 'ACTIVITY_DATABASE_URL',
  'activity-worker': 'ACTIVITY_DATABASE_URL',
  'activity-notifications': 'ACTIVITY_DATABASE_URL',
  geodata: 'GEO_DATABASE_URL',
  'geodata-worker': 'GEO_DATABASE_URL',
  'geodata-importer': null,
  'email-worker': 'CORE_DATABASE_URL',
  'outbox-worker': 'OUTBOX_DATABASE_URL',
};

const nestCli = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, 'nest-cli.json'), 'utf8'),
);
const applications = Object.entries(nestCli.projects || {}).filter(
  ([, project]) => project.type === 'application',
);
const expectedNames = Object.keys(expectedDatabaseByApplication).sort();
const actualNames = applications.map(([name]) => name).sort();
if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames))
  errors.push(
    'NestJS application inventory must have explicit database ownership',
  );

for (const [name, project] of applications) {
  const sourceRoot = path.join(repositoryRoot, project.sourceRoot);
  const mainPath = path.join(sourceRoot, `${project.entryFile || 'main'}.ts`);
  if (!fs.existsSync(mainPath)) {
    errors.push(`${name}: process entry is missing`);
    continue;
  }
  const mainSource = fs.readFileSync(mainPath, 'utf8');
  const rootModuleImport = [
    ...mainSource.matchAll(/import\s*\{([^}]+)\}\s*from\s*(['"])([^'"]+)\2/g),
  ]
    .flatMap((match) =>
      match[1]
        .split(',')
        .map((binding) => binding.trim().split(/\s+as\s+/)[0])
        .filter((binding) => binding.endsWith('Module'))
        .map((binding) => ({ binding, source: match[3] })),
    )
    .find((match) => match.source.startsWith('.'));
  if (!rootModuleImport) {
    errors.push(`${name}: process root module cannot be identified`);
    continue;
  }
  const rootModulePath = path.resolve(
    path.dirname(mainPath),
    rootModuleImport.source.replace(/\.js$/, '') + '.ts',
  );
  if (!fs.existsSync(rootModulePath)) {
    errors.push(`${name}: process root module is missing`);
    continue;
  }
  const moduleSource = fs.readFileSync(rootModulePath, 'utf8');
  const moduleDatabases = [
    ...moduleSource.matchAll(
      /DatabaseHealthModule\.forEnvironment\(\s*(['"])([^'"]+)\1/g,
    ),
  ].map((match) => match[2]);
  const expected = expectedDatabaseByApplication[name];
  const expectedModuleDatabases = expected ? [expected] : [];
  if (
    moduleDatabases.length !== expectedModuleDatabases.length ||
    moduleDatabases.some(
      (database) => !expectedModuleDatabases.includes(database),
    )
  )
    errors.push(
      `${name}: expected ${expected ?? 'no'} direct database connection in its Nest module`,
    );

  const declaredDatabases = new Set();
  for (const filename of fs.readdirSync(sourceRoot, { recursive: true })) {
    if (typeof filename !== 'string' || !filename.endsWith('.ts')) continue;
    const source = fs.readFileSync(path.join(sourceRoot, filename), 'utf8');
    for (const match of source.matchAll(
      /\b(CORE|ACTIVITY|GEO|OUTBOX)_DATABASE_URL(?:_FILE)?\b/g,
    ))
      declaredDatabases.add(
        match[0]
          .replace(/_FILE$/, '')
          .replace(/_DATABASE_URL$/, '_DATABASE_URL'),
      );
  }
  for (const database of declaredDatabases) {
    if (database !== expected)
      errors.push(`${name}: references unassigned database URL ${database}`);
  }
}

const migrationsRoot = path.join(repositoryRoot, 'deploy/db/migrations');
const migrationOwners = fs
  .readdirSync(migrationsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
if (
  JSON.stringify(migrationOwners) !==
  JSON.stringify(['activity', 'core', 'geo'])
)
  errors.push(
    'database migrations must have exactly core, activity, and geo owners',
  );

if (errors.length) {
  process.stderr.write(`${errors.map((error) => `- ${error}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    'Database ownership verified: Core, Activity, and Geodata only.\n',
  );
}
