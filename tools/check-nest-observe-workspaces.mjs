import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const apps = readdirSync('apps', { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const errors = [];

if (!root.workspaces?.includes('apps/*'))
  errors.push('package.json must include apps/* as an npm workspace');
if (!root.dependencies?.['@nestjs/observe'])
  errors.push('root runtime dependencies must include @nestjs/observe');

for (const app of apps) {
  const manifestPath = join('apps', app, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    errors.push(`${app} is missing apps/${app}/package.json`);
    continue;
  }
  if (manifest.dependencies?.['@nestjs/observe'] !== '^0.3.17')
    errors.push(`${app} must declare @nestjs/observe as a runtime dependency`);
  if (!lock.packages?.[`apps/${app}`]?.dependencies?.['@nestjs/observe'])
    errors.push(
      `${app} is missing from the root npm lockfile workspace entries`,
    );
}

if (errors.length) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    `Verified @nestjs/observe runtime declarations and lockfile entries for ${apps.length} NestJS apps.`,
  );
}
