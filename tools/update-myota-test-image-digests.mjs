#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';

const [manifestPath, digestPath, sourceSha] = process.argv.slice(2);

if (!manifestPath || !digestPath || !sourceSha) {
  console.error(
    'Usage: node tools/update-myota-test-image-digests.mjs <values.yaml> <digests.tsv> <testing-sha>',
  );
  process.exit(2);
}

if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
  throw new Error('The source commit must be a full 40-character SHA.');
}

const digestRows = (await readFile(digestPath, 'utf8'))
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => {
    const [app, image, digest] = line.split('\t');
    if (!app || !image || !/^sha256:[0-9a-f]{64}$/.test(digest ?? '')) {
      throw new Error(`Invalid image digest row for ${app || 'unknown app'}.`);
    }
    return { app, digest };
  });

const digestTargets = new Map();
for (const { app, digest } of digestRows) {
  if (app === 'tools') {
    digestTargets.set('migrations.image.digest', digest);
    digestTargets.set('jetstreamProvisioner.image.digest', digest);
  } else if (app !== 'postgres' && app !== 'postgis' && app !== 'nats') {
    digestTargets.set(`images.${app}.digest`, digest);
  }
}

if (digestTargets.size === 0) {
  console.log('No changed image is part of the myota-test application chart.');
  process.exit(0);
}

const lines = (await readFile(manifestPath, 'utf8')).split(/\r?\n/);

function findChild(start, parentIndent, key) {
  const indent = parentIndent + 2;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const currentIndent = line.match(/^ */)[0].length;
    if (line.trim() && currentIndent <= parentIndent) return -1;
    if (currentIndent === indent && line.trimStart().startsWith(`${key}:`)) {
      return index;
    }
  }
  return -1;
}

function replacePath(path, digest) {
  let parentLine = -1;
  for (const key of path.split('.')) {
    parentLine = findChild(
      parentLine,
      parentLine < 0 ? -2 : lines[parentLine].match(/^ */)[0].length,
      key,
    );
    if (parentLine < 0) {
      throw new Error(`Could not find values path ${path} in ${manifestPath}.`);
    }
  }
  const indent = lines[parentLine].match(/^ */)[0].length;
  const match = lines[parentLine].match(
    /^(\s*digest:\s*)sha256:[0-9a-f]{64}(\s*)$/,
  );
  if (path.endsWith('.digest') && match) {
    lines[parentLine] = `${match[1]}${digest}${match[2]}`;
    return;
  }
  if (indent === 0) throw new Error(`Invalid digest mapping at ${path}.`);
  throw new Error(`Expected a digest scalar at ${path}.`);
}

for (const [path, digest] of digestTargets) replacePath(path, digest);

const buildVersionLine = lines.findIndex((line) => /^buildVersion:\s*/.test(line));
if (buildVersionLine < 0) {
  throw new Error(
    `Could not find buildVersion in ${manifestPath}.`,
  );
}
lines[buildVersionLine] = `buildVersion: testing-${sourceSha.slice(0, 7)}`;

await writeFile(manifestPath, lines.join('\n'));
console.log(`Updated ${digestTargets.size} immutable image digest value(s).`);
