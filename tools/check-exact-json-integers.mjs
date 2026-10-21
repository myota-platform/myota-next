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
  /bootstrapHttpService\(\s*ProgrammesModule,[\s\S]*?\[\],\s*\[\],\s*true,\s*'programmes-api',/,
  'Programme API bootstrap must enable BigInt JSON response serialization',
);
requirePattern(
  'libs/platform/src/bootstrap.ts',
  /const exactIntegerRequest =[\s\S]*?request\.method === 'POST'[\s\S]*?'\/v1\/programmes'[\s\S]*?const jsonNumberRequest =[\s\S]*?request\.body = parseJsonWithExactIntegers/,
  'Python numeric-sensitive requests must preserve exact integer and float tokens',
);
requirePattern(
  'libs/platform/src/bootstrap.ts',
  /express\.json\([\s\S]*?["']\/v1\/qso-ingestions["'][\s\S]*?Object\.assign\(request, \{ rawBody: buffer \}\)/,
  'QSO ingestion requests must retain raw JSON bytes for exact numeric parsing',
);
requirePattern(
  'libs/platform/src/bootstrap.ts',
  /express\.json\([\s\S]*?\^\\\/v1\\\/activations\\\/\[\^\/\]\+\\\/qsos\$[\s\S]*?Object\.assign\(request, \{ rawBody: buffer \}\)/,
  'Direct QSO writes must retain raw JSON bytes for exact numeric parsing',
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
  'apps/outbox-worker/src/outbox-worker.service.ts',
  /const ack = await this\.relay!\.publish[\s\S]*?msgID: event\.eventId[\s\S]*?if \(acknowledgedStream !== routed\.stream\)[\s\S]*?this\.published \+= 1;[\s\S]*?const client = await this\.pool!\.connect\(\)[\s\S]*?JetStream acknowledged event \$\{event\.eventId\}, but the outbox mark failed:/,
  'An outbox database-mark failure after JetStream ACK must leave the event pending for stable-ID retry',
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
  /bootstrapHttpService\([\s\S]*?^\s*\[\],\s*true,\s*'geodata-api',/m,
  'Geodata API bootstrap must enable BigInt JSON response serialization and label HTTP metrics',
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
  'apps/geodata-importer/src/geodata-importer.service.ts',
  /features\.length > MAX_IMPORT_FEATURES/,
  'Scheduled importer must use the shared Python-compatible Geodata feature limit',
);
if (
  /MAX_SOURCE_BYTES/.test(
    fs.readFileSync(
      path.join(
        repositoryRoot,
        'apps/geodata-importer/src/geodata-importer.service.ts',
      ),
      'utf8',
    ),
  )
)
  errors.push(
    'Scheduled importer must not impose a smaller source response cap',
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
  /features\.length > MAX_IMPORT_FEATURES/,
  'Geodata API must use the shared Python-compatible feature limit',
);
requirePattern(
  'apps/geodata-worker/src/geodata-work.repository.ts',
  /const featureLimit = MAX_IMPORT_FEATURES/,
  'Geodata worker must use the shared Python-compatible feature limit',
);
requirePattern(
  'apps/geodata-worker/src/geodata-work.repository.ts',
  /parsePageTotal\(\s*stats\.rows\[0\]\?\.preprocessed[\s\S]*?parsePageTotal\(stats\.rows\[0\]\?\.errors[\s\S]*?parsePageTotal\(stats\.rows\[0\]\?\.skipped[\s\S]*?parsePageTotal\(stats\.rows\[0\]\?\.conflation/,
  'Geodata staging statistics must preserve exact PostgreSQL counts',
);
requirePattern(
  'apps/geodata-worker/src/geodata-work.repository.ts',
  /manifestRecordCount = parsePageTotal\([\s\S]*?recordCount',\$7::bigint/,
  'Geodata snapshot manifest counts must remain exact through persistence and event construction',
);
requirePattern(
  'deploy/db/migrations/geo/007_geodata_snapshot_count_bigint.sql',
  /ALTER TABLE public\.source_snapshot_manifest[\s\S]*?record_count TYPE bigint/,
  'Geodata snapshot manifest count storage must support PostgreSQL bigint totals',
);
requirePattern(
  'apps/geodata/src/geodata.repository.ts',
  /\(\$\{importProjection\}\)::text AS run[\s\S]*?parseJsonWithExactIntegers\(row\.run\)[\s\S]*?parseJsonWithExactIntegers\(\s*result\.rows\[0\]\.run/s,
  'Geodata import status reads must preserve exact JSONB integers',
);
requirePattern(
  'apps/geodata-worker/src/geodata-work.repository.ts',
  /lease_until=now\(\)\+make_interval\(secs=>\$2\)[\s\S]*?IMPORT_RUN_LEASE_SECONDS[\s\S]*?async heartbeat\(run: ImportRun\): Promise<void>[\s\S]*?lease_until=now\(\)\+make_interval\(secs=>\$3\)/,
  'Geodata import claims and heartbeats must use the configured lease duration',
);
requirePattern(
  'apps/geodata-worker/src/geodata-worker.service.ts',
  /heartbeatIntervalSeconds: IMPORT_RUN_HEARTBEAT_SECONDS[\s\S]*?this\.repository\.renewHeartbeat\(job\)[\s\S]*?definition\.heartbeatIntervalSeconds \?\? 30/,
  'Geodata imports must renew database leases at the configured Python-compatible heartbeat interval',
);
requirePattern(
  'apps/geodata-worker/src/geodata-worker.service.ts',
  /leaseHeld = await definition\.heartbeat\?\.\(job\)[\s\S]*?Geodata work heartbeat failed; processing continues[\s\S]*?leaseHeld === false[\s\S]*?Geodata work lease was lost/,
  'Geodata workers must continue after transient heartbeat errors and stop when lease ownership is lost',
);
requirePattern(
  'apps/activity-worker/src/activity-worker.service.ts',
  /let extended: boolean \| undefined[\s\S]*?this\.repository\.heartbeat\(job\)[\s\S]*?Activity work heartbeat failed; processing continues[\s\S]*?extended === false[\s\S]*?worker lease was lost while processing/,
  'Activity workers must continue after transient heartbeat errors and stop when lease ownership is lost',
);
requirePattern(
  'apps/geodata-worker/src/geodata-worker.service.ts',
  /acknowledgementIntervalMs = Math\.max\([\s\S]*?definition\.ackWaitSeconds \* 1000\) \/ 3[\s\S]*?lastAcknowledgement/,
  'Geodata JetStream acknowledgements must be extended independently at one third of the durable ACK wait',
);
requirePattern(
  'libs/platform/src/geodata-consumer-policy.ts',
  /'geodata-preprocessing-v1':[\s\S]*?legacyMaxPendingSetting: 'MYOTA_IMPORT_WORKERS'[\s\S]*?'geodata-import-promotion-v1':[\s\S]*?legacyMaxPendingSetting: 'MYOTA_IMPORT_WORKERS'[\s\S]*?export function geodataImportConcurrency[\s\S]*?optionalWorkerConcurrencySetting\('MYOTA_IMPORT_WORKERS', environment\) \?\? 2/,
  'Legacy import concurrency must cover both import durable policies',
);
requirePattern(
  'apps/geodata-worker/src/geodata-worker.service.ts',
  /this\.importSemaphore = new AsyncSemaphore\(geodataImportConcurrency\(\)\)[\s\S]*?const importWork =[\s\S]*?this\.importSemaphore\.acquire\(\)/,
  'Geodata preprocessing and promotion must share the configured import concurrency cap',
);
requirePattern(
  'apps/geodata/src/geodata-upload.service.ts',
  /MYOTA_UPLOAD_WORKERS[\s\S]*?new AsyncSemaphore\(UPLOAD_WORKERS\)[\s\S]*?async complete\(owner: string, id: string\)[\s\S]*?this\.uploadSemaphore\.acquire\(\)/,
  'Geodata upload finalization must respect its legacy per-process concurrency limit',
);
requirePattern(
  'libs/platform/src/import-limits.ts',
  /MAX_UPLOAD_BYTES = integerSetting\([\s\S]*?MAX_GEOJSON_UPLOAD_BYTES = integerSetting\([\s\S]*?MAX_OSM_PBF_UPLOAD_BYTES = integerSetting\([\s\S]*?MAX_SHAPEFILE_UPLOAD_BYTES = integerSetting\([\s\S]*?MAX_IMPORT_FEATURES = integerSetting\(\s*process\.env\.GEODATA_MAX_IMPORT_FEATURES,\s*5000,[\s\S]*?IMPORT_RUN_LEASE_SECONDS = Math\.max\([\s\S]*?MYOTA_IMPORT_LEASE_SECONDS,[\s\S]*?IMPORT_RUN_HEARTBEAT_SECONDS = Math\.max\([\s\S]*?MYOTA_IMPORT_HEARTBEAT_SECONDS,[\s\S]*?MAX_IMPORT_FEATURE_VERTICES = integerSetting\([\s\S]*?MYOTA_IMPORT_MAX_FEATURE_VERTICES[\s\S]*?MAX_SHAPEFILE_EXPANDED_BYTES = integerSetting\([\s\S]*?MYOTA_IMPORT_MAX_SHAPEFILE_EXPANDED_BYTES[\s\S]*?MAX_IMPORT_BATCH_BYTES = Math\.max\([\s\S]*?MYOTA_IMPORT_BATCH_BYTES[\s\S]*?MAX_IMPORT_BATCH_FEATURES = Math\.max\([\s\S]*?MYOTA_IMPORT_BATCH_SIZE/,
  'Geodata upload, decoder, and batch limits must use Python-compatible integer settings',
);
for (const relativePath of [
  'apps/geodata/src/geodata-xml-import.ts',
  'apps/geodata-worker/src/geodata-geojson-stream.ts',
  'apps/geodata-worker/src/geodata-osm-pbf.ts',
  'apps/geodata-worker/src/geodata-shapefile-stream.ts',
])
  requirePattern(
    relativePath,
    /MAX_IMPORT_FEATURE_VERTICES/,
    `${relativePath} must honor the configured Geodata vertex limit`,
  );
requirePattern(
  'apps/geodata-worker/src/geodata-shapefile-stream.ts',
  /MAX_SHAPEFILE_EXPANDED_BYTES/,
  'Shapefile streaming must honor its configured expanded-size limit',
);
for (const [relativePath, limitName] of [
  [
    'apps/geodata-worker/src/geodata-geojson-stream.ts',
    'MAX_GEOJSON_UPLOAD_BYTES',
  ],
  ['apps/geodata-worker/src/geodata-osm-pbf.ts', 'MAX_OSM_PBF_UPLOAD_BYTES'],
  [
    'apps/geodata-worker/src/geodata-shapefile-stream.ts',
    'MAX_SHAPEFILE_UPLOAD_BYTES',
  ],
])
  requirePattern(
    relativePath,
    new RegExp(`sourceLimit = ${limitName}|archiveLimit = ${limitName}`),
    `${relativePath} must use the same source cap as upload admission`,
  );
requirePattern(
  'apps/geodata/src/geodata-upload.service.ts',
  /MAX_GEOJSON_UPLOAD_BYTES[\s\S]*?MAX_OSM_PBF_UPLOAD_BYTES[\s\S]*?MAX_SHAPEFILE_UPLOAD_BYTES[\s\S]*?MAX_UPLOAD_BYTES/,
  'Geodata upload admission must use the shared format-specific source caps',
);
requirePattern(
  'apps/geodata-worker/src/geodata-work.repository.ts',
  /stagedBytes \+ featureBytes > MAX_IMPORT_BATCH_BYTES[\s\S]*?staged\.length >= MAX_IMPORT_BATCH_FEATURES[\s\S]*?stagedBytes >= MAX_IMPORT_BATCH_BYTES/,
  'Geodata staging batches must honor configured feature-count and serialized-byte bounds',
);
requirePattern(
  'apps/geodata-worker/src/geodata-osm-pbf.ts',
  /MAX_OSM_PBF_UPLOAD_BYTES[\s\S]*?Buffer\.byteLength\(trimmed, 'utf8'\) > MAX_IMPORT_FEATURE_BYTES/,
  'OSM PBF output must stream without a stricter aggregate cap while retaining per-feature and source-upload limits',
);
if (
  /MAX_OUTPUT_BYTES/.test(
    fs.readFileSync(
      path.join(repositoryRoot, 'apps/geodata-worker/src/geodata-osm-pbf.ts'),
      'utf8',
    ),
  )
)
  errors.push('OSM PBF decoding must not impose an aggregate output-size cap');
requirePattern(
  'libs/platform/src/bootstrap.ts',
  /containsBigIntOrFloatMetadata\(body\)[\s\S]*?stringifyJsonWithBigInts\(body\)/,
  'shared HTTP bootstrap must preserve exact number response tokens',
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
    'Exact JSON integers, Python-compatible Geodata integer settings, and import batch, lease, and source limits are guarded across the API, workers, and scheduled importer.\n',
  );
}
