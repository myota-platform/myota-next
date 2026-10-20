import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const errors = [];

function requirePattern(relativePath, pattern, description) {
  const source = fs.readFileSync(
    path.join(repositoryRoot, relativePath),
    'utf8',
  );
  if (!pattern.test(source)) errors.push(description);
}

requirePattern(
  'libs/platform/src/json-exact.ts',
  /export function parseJsonWithExactIntegers[\s\S]*?Number\.MAX_SAFE_INTEGER[\s\S]*?integer/,
  'Shared JSON parser must preserve integers outside the JavaScript safe range',
);
requirePattern(
  'apps/programmes/src/programmes.module.ts',
  /DatabaseHealthModule\.forEnvironment\([\s\S]*?CORE_DATABASE_URL[\s\S]*?parseJsonWithExactIntegers/,
  'Programme API pool must enable exact integer parsing',
);
requirePattern(
  'apps/programmes/src/main.ts',
  /bootstrapHttpService\(ProgrammesModule,[\s\S]*?\[\],\s*\[\],\s*true\)/,
  'Programme API bootstrap must enable BigInt JSON response serialization',
);
requirePattern(
  'libs/platform/src/bootstrap.ts',
  /request\.url\?\.split\('\?', 1\)\[0\] === '\/v1\/programmes'[\s\S]*?parseJsonWithExactIntegers/,
  'Programme creation requests must preserve exact JSON integers',
);
requirePattern(
  'libs/platform/src/bootstrap.ts',
  /'\/v1\/geodata\/refresh-schedules'[\s\S]*?parseJsonWithExactIntegers/,
  'Geodata schedule creation requests must preserve exact JSON integers',
);
requirePattern(
  'apps/outbox-worker/src/outbox-worker.module.ts',
  /DatabaseHealthModule\.forEnvironment\([\s\S]*?OUTBOX_DATABASE_URL[\s\S]*?parseJsonWithExactIntegers/,
  'Outbox worker pool must enable exact integer parsing',
);
requirePattern(
  'libs/platform/src/database.module.ts',
  /oid === 114 \|\| oid === 3802[\s\S]*?parseJson/,
  'shared PostgreSQL pool must apply the configured parser to JSON and JSONB',
);
requirePattern(
  'apps/geodata/src/geodata.module.ts',
  /DatabaseHealthModule\.forEnvironment\([\s\S]*?GEO_DATABASE_URL[\s\S]*?parseJsonWithExactIntegers/,
  'Geodata API pool must enable exact integer parsing',
);
requirePattern(
  'apps/geodata-worker/src/geodata-worker.module.ts',
  /DatabaseHealthModule\.forEnvironment\([\s\S]*?GEO_DATABASE_URL[\s\S]*?parseJsonWithExactIntegers/,
  'Geodata worker pool must enable exact integer parsing',
);
requirePattern(
  'apps/geodata/src/main.ts',
  /bootstrapHttpService\([\s\S]*?^\s*\[\],\s*true,/m,
  'Geodata API bootstrap must enable BigInt JSON response serialization',
);
requirePattern(
  'apps/geodata/src/geodata-schedule.service.ts',
  /payload::text AS payload_json[\s\S]*?parseJsonWithExactIntegers\(String\(row\.payload_json\)\)/,
  'Geodata schedules must preserve exact JSON integers when read from PostgreSQL',
);
requirePattern(
  'apps/geodata-importer/src/geodata-importer.service.ts',
  /parseJsonWithExactIntegers\(await response\.text\(\)\)/,
  'Scheduled importer must preserve exact JSON integers from the API',
);
requirePattern(
  'apps/geodata-importer/src/geodata-importer.service.ts',
  /typeof schedule\.intervalSeconds === 'bigint'[\s\S]*?schedule\.intervalSeconds \* 1000n/,
  'Scheduled importer must calculate arbitrary-precision intervals',
);
requirePattern(
  'apps/geodata/src/geodata.controller.ts',
  /parseImportPartNumber\(partNumber\)[\s\S]*?function parseImportPartNumber\(value: string\): number[\s\S]*?normalizePythonNumericText\(value\)[\s\S]*?BigInt\(normalized\.replaceAll\('_', ''\)\)[\s\S]*?parsed > 10000n/,
  'Geodata multipart upload part numbers must follow Python integer parsing and bounds',
);
requirePattern(
  'apps/geodata/src/geodata-upload.service.ts',
  /const parsedExpectedSize = pythonInteger\(body\.expectedSize\)[\s\S]*?function pythonInteger\(value: unknown\): bigint \| null[\s\S]*?normalizePythonNumericText\(value\)[\s\S]*?BigInt\(normalized\.replaceAll\('_', ''\)\)/,
  'Geodata multipart expected sizes must follow Python integer conversion before size bounds',
);
requirePattern(
  'apps/geodata/src/geodata-import.service.ts',
  /const maxFeatures = integerSetting\([\s\S]*?process\.env\.GEODATA_MAX_IMPORT_FEATURES[\s\S]*?5000/,
  'Geodata API feature limits must parse configuration with Python-compatible integer settings',
);
requirePattern(
  'apps/geodata-worker/src/geodata-work.repository.ts',
  /const featureLimit = integerSetting\([\s\S]*?process\.env\.GEODATA_MAX_IMPORT_FEATURES,[\s\S]*?5000/,
  'Geodata worker feature limits must parse configuration with Python-compatible integer settings',
);
requirePattern(
  'libs/platform/src/bootstrap.ts',
  /containsBigInt\(body\)[\s\S]*?stringifyJsonWithBigInts\(body\)/,
  'shared HTTP bootstrap must serialize BigInt responses as JSON integers',
);

function visitTypeScript(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) visitTypeScript(filename);
    else if (entry.isFile() && filename.endsWith('.ts')) {
      const source = fs.readFileSync(filename, 'utf8');
      if (
        filename !==
          path.join(
            repositoryRoot,
            'apps/geodata/src/geodata-request-fingerprint.ts',
          ) &&
        /JSON\.stringify\(/.test(source)
      )
        errors.push(
          `${path.relative(repositoryRoot, filename)} must use the BigInt-safe JSON serializer`,
        );
    }
  }
}

for (const component of [
  'apps/geodata/src',
  'apps/geodata-worker/src',
  'apps/geodata-importer/src',
])
  visitTypeScript(path.join(repositoryRoot, component));

if (errors.length) {
  process.stderr.write(`${errors.map((error) => `- ${error}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    'Exact JSON integers and Python-compatible Geodata multipart integer conversions are guarded across the API, workers, and scheduled importer.\n',
  );
}
