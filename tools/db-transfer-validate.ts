import { lstat, open, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from 'pg';

const owners = {
  core: {
    sourceVariable: 'LEGACY_CORE_DATABASE_URL',
    targetVariable: 'CORE_DATABASE_URL',
  },
  activity: {
    sourceVariable: 'LEGACY_ACTIVITY_DATABASE_URL',
    targetVariable: 'ACTIVITY_DATABASE_URL',
  },
  geo: {
    sourceVariable: 'LEGACY_GEO_DATABASE_URL',
    targetVariable: 'GEO_DATABASE_URL',
  },
} as const;
type Owner = keyof typeof owners;
type Endpoint = {
  database: string;
  host: string;
  port: string;
  url: string;
};
type TableFingerprint = { rows: string; fingerprint: string };
type Check = {
  name: string;
  status: 'passed' | 'failed';
  source?: unknown;
  target?: unknown;
  detail?: string;
};
type ValidationReport = {
  validationVersion: 1;
  status: 'database-checks-passed-parity-review-required' | 'failed';
  dataValidated: false;
  sourceBaseline: string;
  archiveDirectory: string;
  createdAt: string;
  targetConfirmation: string;
  fingerprint: 'PostgreSQL 64-bit row hash XOR plus row count';
  owners: Record<Owner, { checks: Check[] }>;
  manualReviewRequired: string[];
};

const baseline =
  'myota-platform/myota@7f904a5130e59006765cf882956a4adbfecb17ec';
const emailBaseline =
  'myota-platform/myota-email-worker@be5a4d965fb8465fd0ce3c3172bde8a0af38aec1';
const emailMigrationSha256 =
  '58b6e627141c37bbacf196f786bdc992bdb315c9d16d50b50139b4073c85c11a';
const legacyEmailTables = [
  'email_delivery',
  'email_delivery_attempt',
  'email_dead_letter',
  'email_dead_letter_redrive',
];
const coreChangedTables = new Set([
  'account',
  'account_role',
  'callsign',
  'service_state',
]);
const coreStableProjections: Record<string, string> = {
  account: 'id,display_name,participation_type,status,created_at,updated_at',
  account_role:
    'id,account_id,programme_id,role_code,jurisdiction_id,entity_type_code,scopes,created_at,valid_to',
  callsign:
    'id,account_id,value,lifecycle_status,verification_source,verified_at,valid_from,valid_to',
};
const expectedTargetOnlyTables: Record<Owner, Set<string>> = {
  core: new Set([
    'email_delivery',
    'email_delivery_attempt',
    'email_dead_letter',
    'email_dead_letter_redrive',
    'identity_casefold_mapping',
    'programme_content',
    'programme_entity_type',
    'programme_policy_draft',
    'programme_record',
  ]),
  activity: new Set(),
  geo: new Set(['geodata_import_candidate_stage']),
};

async function main() {
  process.umask(0o077);
  const archive = parseArchiveDirectory(process.argv.slice(2));
  if (process.env.MYOTA_TRANSFER_SOURCE_FROZEN !== 'YES')
    throw new Error(
      'Set MYOTA_TRANSFER_SOURCE_FROZEN=YES after stopping all Python writers',
    );
  if (process.env.MYOTA_TRANSFER_TARGET_OFFLINE !== 'YES')
    throw new Error(
      'Set MYOTA_TRANSFER_TARGET_OFFLINE=YES after stopping all NestJS target writers',
    );
  const endpoints = {} as Record<Owner, { source: Endpoint; target: Endpoint }>;
  for (const owner of Object.keys(owners) as Owner[]) {
    const config = owners[owner];
    endpoints[owner] = {
      source: endpoint(config.sourceVariable),
      target: endpoint(config.targetVariable),
    };
  }
  const emailSource = endpoint('LEGACY_EMAIL_DATABASE_URL');
  assertSevenDistinctEndpoints(endpoints, emailSource);

  const confirmation = validationConfirmation(endpoints);
  if (process.env.MYOTA_TRANSFER_VALIDATION_CONFIRM !== confirmation)
    throw new Error(
      `Set MYOTA_TRANSFER_VALIDATION_CONFIRM to exactly: ${confirmation}`,
    );
  await assertApplyReport(archive, confirmation, endpoints, emailSource);

  const report: ValidationReport = {
    validationVersion: 1,
    status: 'database-checks-passed-parity-review-required',
    dataValidated: false,
    sourceBaseline: baseline,
    archiveDirectory: archive,
    createdAt: new Date().toISOString(),
    targetConfirmation: confirmation,
    fingerprint: 'PostgreSQL 64-bit row hash XOR plus row count',
    owners: {
      core: { checks: [] },
      activity: { checks: [] },
      geo: { checks: [] },
    },
    manualReviewRequired: [
      'Object-store object keys and content have not been compared.',
      'JetStream stream contents and pending work have not been compared.',
      'API, authorization, user workflow, and worker function parity require separate compatibility evidence.',
      'The table fingerprints use PostgreSQL hashtextextended; compare databases running the same PostgreSQL major version.',
    ],
  };

  for (const owner of Object.keys(owners) as Owner[]) {
    const source = new Client({
      connectionString: endpoints[owner].source.url,
      application_name: `myota-transfer-validate-${owner}-source`,
      connectionTimeoutMillis: 10_000,
    });
    const target = new Client({
      connectionString: endpoints[owner].target.url,
      application_name: `myota-transfer-validate-${owner}-target`,
      connectionTimeoutMillis: 10_000,
    });
    try {
      await source.connect();
      await target.connect();
      await source.query('BEGIN READ ONLY');
      await target.query('BEGIN READ ONLY');
      await source.query("SET LOCAL TIME ZONE 'UTC'");
      await target.query("SET LOCAL TIME ZONE 'UTC'");
      await source.query("SET LOCAL DateStyle TO 'ISO, YMD'");
      await target.query("SET LOCAL DateStyle TO 'ISO, YMD'");
      await source.query('SET LOCAL extra_float_digits TO 3');
      await target.query('SET LOCAL extra_float_digits TO 3');
      const sourceVersion = await serverMajor(source);
      const targetVersion = await serverMajor(target);
      addCheck(report, owner, {
        name: 'postgres-major-version',
        status: sourceVersion === targetVersion ? 'passed' : 'failed',
        source: sourceVersion,
        target: targetVersion,
        detail:
          sourceVersion === targetVersion
            ? undefined
            : 'Row fingerprints require matching PostgreSQL major versions',
      });

      const sourceTables = await applicationTables(source);
      const targetTables = await applicationTables(target);
      await compareTables(
        report,
        owner,
        source,
        target,
        sourceTables,
        targetTables,
      );

      if (owner === 'core')
        await validateCoreTransforms(report, source, target);
      if (owner === 'activity') await validateActivity(report, target);
      if (owner === 'geo') await validateGeodata(report, target);
      await source.query('ROLLBACK');
      await target.query('ROLLBACK');
    } catch (error) {
      addCheck(report, owner, {
        name: 'database-validation-execution',
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await Promise.allSettled([source.end(), target.end()]);
    }
  }
  await validateLegacyEmail(report, emailSource, endpoints.core.target);

  const failed = Object.values(report.owners).some(({ checks }) =>
    checks.some((check) => check.status === 'failed'),
  );
  if (failed) report.status = 'failed';
  const path = join(
    archive,
    `validation-report-${new Date().toISOString().replaceAll(/[-:.]/g, '')}-${process.pid}.json`,
  );
  await writeJsonExclusive(path, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (failed) process.exitCode = 1;
}

function parseArchiveDirectory(args: string[]) {
  if (args.length !== 1 || !args[0].startsWith('--archive-dir='))
    throw new Error(
      'Usage: npm run db:transfer:validate -- --archive-dir=TRANSFER_DIRECTORY',
    );
  const archive = resolve(args[0].slice('--archive-dir='.length));
  if (archive === join(archive, '..'))
    throw new Error('Transfer archive directory must not be a filesystem root');
  return archive;
}

function endpoint(variable: string): Endpoint {
  const raw = process.env[variable];
  if (!raw) throw new Error(`${variable} is required`);
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error(`${variable} must be a PostgreSQL URL`);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database || !url.hostname)
    throw new Error(`${variable} must include a host and database`);
  return {
    database,
    host: url.hostname.toLowerCase(),
    port: url.port || '5432',
    url: raw,
  };
}

function endpointId(endpoint: Endpoint) {
  return `${endpoint.host}:${endpoint.port}/${endpoint.database}`;
}

function validationConfirmation(
  endpoints: Record<Owner, { source: Endpoint; target: Endpoint }>,
) {
  return `VALIDATE core=${endpointId(endpoints.core.target)} activity=${endpointId(endpoints.activity.target)} geo=${endpointId(endpoints.geo.target)}`;
}

function assertSevenDistinctEndpoints(
  endpoints: Record<Owner, { source: Endpoint; target: Endpoint }>,
  emailSource: Endpoint,
) {
  const seen = new Map<string, string>();
  for (const owner of Object.keys(owners) as Owner[]) {
    for (const [side, value] of Object.entries(endpoints[owner])) {
      const id = endpointId(value);
      const previous = seen.get(id);
      if (previous)
        throw new Error(
          `${previous} and ${owner} ${side} target the same PostgreSQL database`,
        );
      seen.set(id, `${owner} ${side}`);
    }
  }
  const emailKey = endpointId(emailSource);
  const previous = seen.get(emailKey);
  if (previous)
    throw new Error(
      `${previous} and legacy email source target the same PostgreSQL database`,
    );
}

async function assertApplyReport(
  archive: string,
  confirmation: string,
  endpoints: Record<Owner, { source: Endpoint; target: Endpoint }>,
  emailSource: Endpoint,
) {
  const info = await lstat(archive);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Transfer archive path must be a regular directory');
  const value: unknown = JSON.parse(
    await readFile(join(archive, 'apply-report.json'), 'utf8'),
  );
  if (!value || typeof value !== 'object')
    throw new Error('Transfer apply report is invalid');
  const report = value as Record<string, unknown>;
  const manifestValue: unknown = JSON.parse(
    await readFile(join(archive, 'manifest.json'), 'utf8'),
  );
  if (!manifestValue || typeof manifestValue !== 'object')
    throw new Error('Transfer manifest is invalid');
  const manifest = manifestValue as {
    sourceBaseline?: string;
    owners?: Partial<
      Record<
        Owner,
        {
          source?: { database?: string; host?: string; port?: number };
          targetBackup?: { database?: string; host?: string; port?: number };
        }
      >
    >;
    legacyEmailSource?: {
      repositoryBaseline?: string;
      migrationSha256?: string;
      source?: {
        database?: string;
        host?: string;
        port?: number;
        file?: string;
        sha256?: string;
      };
    };
  };
  const emailEntry = manifest.legacyEmailSource?.source;
  if (
    report.transferVersion !== 2 ||
    report.sourceBaseline !== baseline ||
    report.status !== 'migration-complete-validation-required' ||
    report.targetConfirmation !== confirmation ||
    manifest.sourceBaseline !== baseline ||
    report.emailSourceEndpoint !== endpointId(emailSource) ||
    manifest.legacyEmailSource?.repositoryBaseline !== emailBaseline ||
    manifest.legacyEmailSource?.migrationSha256 !== emailMigrationSha256 ||
    !emailEntry ||
    emailEntry.database !== emailSource.database ||
    emailEntry.host !== emailSource.host ||
    emailEntry.port !== Number(emailSource.port) ||
    emailEntry.file !== 'email-source.dump' ||
    !emailEntry.sha256 ||
    !/^[a-f0-9]{64}$/.test(emailEntry.sha256)
  )
    throw new Error(
      'Transfer apply report is incomplete or names different target databases',
    );
  for (const owner of Object.keys(owners) as Owner[]) {
    const ownerManifest = manifest.owners?.[owner];
    const sourceEntry = ownerManifest?.source;
    const targetEntry = ownerManifest?.targetBackup;
    if (
      !sourceEntry ||
      !targetEntry ||
      sourceEntry.database !== endpoints[owner].source.database ||
      sourceEntry.host !== endpoints[owner].source.host ||
      sourceEntry.port !== Number(endpoints[owner].source.port) ||
      targetEntry.database !== endpoints[owner].target.database ||
      targetEntry.host !== endpoints[owner].target.host ||
      targetEntry.port !== Number(endpoints[owner].target.port)
    )
      throw new Error(
        `Transfer manifest ${owner} endpoints differ from validation endpoints`,
      );
  }
}

async function validateLegacyEmail(
  report: ValidationReport,
  sourceEndpoint: Endpoint,
  coreTargetEndpoint: Endpoint,
) {
  const source = new Client({
    connectionString: sourceEndpoint.url,
    application_name: 'myota-transfer-validate-email-source',
    connectionTimeoutMillis: 10_000,
  });
  const target = new Client({
    connectionString: coreTargetEndpoint.url,
    application_name: 'myota-transfer-validate-email-core-target',
    connectionTimeoutMillis: 10_000,
  });
  try {
    await source.connect();
    await target.connect();
    await source.query('BEGIN READ ONLY');
    await target.query('BEGIN READ ONLY');
    for (const client of [source, target]) {
      await client.query("SET LOCAL TIME ZONE 'UTC'");
      await client.query("SET LOCAL DateStyle TO 'ISO, YMD'");
      await client.query('SET LOCAL extra_float_digits TO 3');
    }
    const sourceMajor = await serverMajor(source);
    const targetMajor = await serverMajor(target);
    addCheck(report, 'core', {
      name: 'legacy-email-postgres-major-version',
      status: sourceMajor === targetMajor ? 'passed' : 'failed',
      source: sourceMajor,
      target: targetMajor,
    });
    const [sourceTables, targetTables] = await Promise.all([
      applicationTables(source),
      applicationTables(target),
    ]);
    const sourceSet = new Set(sourceTables);
    const targetSet = new Set(targetTables);
    const inventoryValid =
      legacyEmailTables.every(
        (table) => sourceSet.has(table) && targetSet.has(table),
      ) && sourceTables.every((table) => legacyEmailTables.includes(table));
    addCheck(report, 'core', {
      name: 'legacy-email-table-inventory',
      status: inventoryValid ? 'passed' : 'failed',
      source: sourceTables,
      target: targetTables.filter((table) => legacyEmailTables.includes(table)),
      detail:
        'The legacy email source must contain exactly the four delivery tables; all four must exist in Core after merging.',
    });
    for (const table of legacyEmailTables) {
      if (!sourceSet.has(table) || !targetSet.has(table)) continue;
      const [sourceFingerprint, targetFingerprint] = await Promise.all([
        tableFingerprint(source, table),
        tableFingerprint(target, table),
      ]);
      const matches =
        sourceFingerprint.rows === targetFingerprint.rows &&
        sourceFingerprint.fingerprint === targetFingerprint.fingerprint;
      addCheck(report, 'core', {
        name: `legacy-email-fingerprint:${table}`,
        status: matches ? 'passed' : 'failed',
        source: sourceFingerprint,
        target: targetFingerprint,
      });
    }
    for (const sequence of [
      'email_delivery_attempt_id_seq',
      'email_dead_letter_id_seq',
      'email_dead_letter_redrive_id_seq',
    ]) {
      const [sourceSequence, targetSequence] = await Promise.all([
        sequenceState(source, sequence),
        sequenceState(target, sequence),
      ]);
      addCheck(report, 'core', {
        name: `legacy-email-sequence:${sequence}`,
        status:
          sourceSequence.lastValue === targetSequence.lastValue &&
          sourceSequence.isCalled === targetSequence.isCalled
            ? 'passed'
            : 'failed',
        source: sourceSequence,
        target: targetSequence,
      });
    }
    await source.query('ROLLBACK');
    await target.query('ROLLBACK');
  } catch (error) {
    addCheck(report, 'core', {
      name: 'legacy-email-validation-execution',
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await Promise.allSettled([source.end(), target.end()]);
  }
}

async function sequenceState(client: Client, sequence: string) {
  const result = await client.query<{
    last_value: string;
    is_called: boolean;
  }>(
    `SELECT last_value::text,is_called FROM public.${quoteIdentifier(sequence)}`,
  );
  return {
    lastValue: result.rows[0]?.last_value ?? null,
    isCalled: result.rows[0]?.is_called ?? null,
  };
}

async function serverMajor(client: Client) {
  const result = await client.query<{ version: string }>(
    'SHOW server_version_num',
  );
  return Math.floor(Number(result.rows[0]?.version) / 10_000);
}

async function applicationTables(client: Client) {
  const result = await client.query<{ table_name: string }>(`
    SELECT c.relname AS table_name
      FROM pg_class AS c
      JOIN pg_namespace AS n ON n.oid=c.relnamespace
     WHERE n.nspname='public'
       AND c.relkind IN ('r','p')
       AND NOT c.relispartition
       AND c.relname NOT IN (
         'myota_schema_migration', 'myota_deployment_schema_state'
       )
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend AS d
          WHERE d.classid='pg_class'::regclass
            AND d.objid=c.oid
            AND d.deptype='e'
       )
     ORDER BY c.relname
  `);
  return result.rows.map(({ table_name }) => table_name);
}

async function compareTables(
  report: ValidationReport,
  owner: Owner,
  source: Client,
  target: Client,
  sourceTables: string[],
  targetTables: string[],
) {
  const sourceSet = new Set(sourceTables);
  const targetSet = new Set(targetTables);
  const sourceOnly = sourceTables.filter((name) => !targetSet.has(name));
  const targetOnly = targetTables.filter((name) => !sourceSet.has(name));
  const allowedTargetOnly = expectedTargetOnlyTables[owner];
  const unexpectedSourceOnly = sourceOnly;
  const unexpectedTargetOnly = targetOnly.filter(
    (name) => !allowedTargetOnly.has(name),
  );
  const missingExpectedTargetTables = [...allowedTargetOnly].filter(
    (name) => !targetSet.has(name),
  );
  addCheck(report, owner, {
    name: 'application-table-inventory',
    status:
      unexpectedSourceOnly.length ||
      unexpectedTargetOnly.length ||
      missingExpectedTargetTables.length
        ? 'failed'
        : 'passed',
    source: sourceTables.length,
    target: targetTables.length,
    detail: JSON.stringify({
      sourceOnly: unexpectedSourceOnly,
      expectedTargetOnly: targetOnly.filter((name) =>
        allowedTargetOnly.has(name),
      ),
      unexpectedTargetOnly,
      missingExpectedTargetTables,
    }),
  });

  for (const table of sourceTables.filter((name) => targetSet.has(name))) {
    if (owner === 'core' && coreChangedTables.has(table)) {
      if (table === 'service_state') {
        await validateServiceStateMigration(report, source, target);
        continue;
      }
      const projection = coreStableProjections[table];
      const comparison = await compareFingerprints(
        source,
        `SELECT ${projection} FROM public.${quoteIdentifier(table)}`,
        target,
        `SELECT ${projection} FROM public.${quoteIdentifier(table)}`,
      );
      addCheck(report, owner, {
        name: `stable-columns:${table}`,
        status: comparison.matches ? 'passed' : 'failed',
        source: comparison.source,
        target: comparison.target,
        detail:
          'Columns changed by Core forward migrations are validated separately.',
      });
      continue;
    }
    const [sourceFingerprint, targetFingerprint] = await Promise.all([
      tableFingerprint(source, table),
      tableFingerprint(target, table),
    ]);
    const matches =
      sourceFingerprint.rows === targetFingerprint.rows &&
      sourceFingerprint.fingerprint === targetFingerprint.fingerprint;
    addCheck(report, owner, {
      name: `table-fingerprint:${table}`,
      status: matches ? 'passed' : 'failed',
      source: sourceFingerprint,
      target: targetFingerprint,
    });
  }
}

async function tableFingerprint(
  client: Client,
  table: string,
): Promise<TableFingerprint> {
  const result = await client.query<{ rows: string; fingerprint: string }>(`
    SELECT count(*)::text AS rows,
           COALESCE(bit_xor(hashtextextended(to_jsonb(row_value)::text,0)),0)::text AS fingerprint
      FROM public.${quoteIdentifier(table)} AS row_value
  `);
  return {
    rows: result.rows[0]?.rows ?? '0',
    fingerprint: result.rows[0]?.fingerprint ?? '0',
  };
}

async function validateCoreTransforms(
  report: ValidationReport,
  source: Client,
  target: Client,
) {
  const programmeRecords = await compareFingerprints(
    source,
    `
      SELECT entry.key AS id,
             CASE WHEN entry.value->'entityTypeCodes' IS NOT NULL
               THEN entry.value
               ELSE jsonb_set(
                 entry.value,
                 '{entityTypeCodes}',
                 COALESCE(
                   (SELECT jsonb_agg(DISTINCT upper(trim(entity.value->>'code')))
                      FROM jsonb_array_elements(
                        CASE WHEN jsonb_typeof(entry.value->'entityTypes')='array'
                          THEN entry.value->'entityTypes' ELSE '[]'::jsonb END
                      ) AS entity(value)
                     WHERE jsonb_typeof(entity.value)='object'
                       AND COALESCE(trim(entity.value->>'code'),'')<>''),
                   '[]'::jsonb
                 ),
                 true
               )
             END AS payload
        FROM public.service_state AS snapshot
        CROSS JOIN LATERAL jsonb_each(
          CASE WHEN jsonb_typeof(snapshot.state->'items')='object'
            THEN snapshot.state->'items' ELSE '{}'::jsonb END
        ) AS entry(key,value)
       WHERE snapshot.service='programmes'
         AND jsonb_typeof(entry.value)='object'
    `,
    target,
    'SELECT slug AS id,payload FROM public.programme_record',
  );
  addCheck(report, 'core', {
    name: 'programme-record-payloads',
    status: programmeRecords.matches ? 'passed' : 'failed',
    source: programmeRecords.source,
    target: programmeRecords.target,
    detail:
      'Legacy Programme records must match the normalized target payloads.',
  });

  const programmeContent = await compareFingerprints(
    source,
    `
      SELECT entry.key AS id,entry.value AS payload
        FROM public.service_state AS snapshot
        CROSS JOIN LATERAL jsonb_each(
          CASE WHEN jsonb_typeof(snapshot.state #> '{data,content}')='object'
            THEN snapshot.state #> '{data,content}' ELSE '{}'::jsonb END
        ) AS entry(key,value)
       WHERE snapshot.service='programmes'
         AND jsonb_typeof(entry.value)='object'
    `,
    target,
    'SELECT id,payload FROM public.programme_content',
  );
  addCheck(report, 'core', {
    name: 'programme-content-payloads',
    status: programmeContent.matches ? 'passed' : 'failed',
    source: programmeContent.source,
    target: programmeContent.target,
    detail:
      'Legacy Programme content documents must match normalized target payloads.',
  });

  const [sourceCodes, targetCodes] = await Promise.all([
    expectedProgrammeEntityTypeCodes(source),
    target.query<{ code: string }>(
      'SELECT code FROM public.programme_entity_type ORDER BY code',
    ),
  ]);
  const expectedCodes = sourceCodes.rows.map(({ code }) => code);
  const actualCodes = targetCodes.rows.map(({ code }) => code);
  addCheck(report, 'core', {
    name: 'programme-entity-type-codes',
    status:
      JSON.stringify(expectedCodes) === JSON.stringify(actualCodes)
        ? 'passed'
        : 'failed',
    source: expectedCodes,
    target: actualCodes,
  });

  const identityEmails = await compareFingerprints(
    source,
    `
      WITH legacy_emails AS (
        SELECT (entry.value->>'id')::uuid AS id,
               nullif(entry.value->>'email','') AS email
          FROM public.service_state AS snapshot
          CROSS JOIN LATERAL jsonb_each(
            COALESCE(NULLIF(snapshot.state->'items','null'::jsonb),'{}'::jsonb)
          ) AS entry(key,value)
         WHERE snapshot.service='identity'
      )
      SELECT account.id,
             CASE WHEN legacy.id IS NOT NULL THEN legacy.email
                  ELSE account.email::text END AS email
        FROM public.account AS account
        LEFT JOIN legacy_emails AS legacy ON legacy.id=account.id
    `,
    target,
    'SELECT id,email::text AS email FROM public.account',
  );
  addCheck(report, 'core', {
    name: 'identity-email-values',
    status: identityEmails.matches ? 'passed' : 'failed',
    source: identityEmails.source,
    target: identityEmails.target,
    detail:
      'Relational Identity emails must retain values from the legacy snapshot or the source account row.',
  });

  const identity = await target.query<{
    accounts: string;
    emailKeysMissing: string;
    emailKeysIncorrect: string;
    duplicateEmailKeys: string;
    casefoldMappings: string;
  }>(`
    SELECT
      (SELECT count(*)::text FROM public.account) AS accounts,
      (SELECT count(*)::text FROM public.account
        WHERE email IS NOT NULL AND identity_email_key IS NULL) AS "emailKeysMissing",
      (SELECT count(*)::text FROM public.account
        WHERE email IS NOT NULL
          AND identity_email_key IS DISTINCT FROM public.identity_casefold(btrim(email::text))) AS "emailKeysIncorrect",
      (SELECT count(*)::text FROM (
        SELECT identity_email_key FROM public.account
         WHERE identity_email_key IS NOT NULL
         GROUP BY identity_email_key HAVING count(*)>1
      ) AS duplicate_keys) AS "duplicateEmailKeys",
      (SELECT count(*)::text FROM public.identity_casefold_mapping) AS "casefoldMappings"
  `);
  const identityRow = identity.rows[0];
  const identityPassed =
    !!identityRow &&
    identityRow.emailKeysMissing === '0' &&
    identityRow.emailKeysIncorrect === '0' &&
    identityRow.duplicateEmailKeys === '0' &&
    Number(identityRow.casefoldMappings) > 0;
  addCheck(report, 'core', {
    name: 'identity-email-normalization',
    status: identityPassed ? 'passed' : 'failed',
    target: identityRow,
  });
}

async function validateServiceStateMigration(
  report: ValidationReport,
  source: Client,
  target: Client,
) {
  const [sourceIdentity, targetIdentity, sourceCounts, targetCounts] =
    await Promise.all([
      fingerprintQuery(
        source,
        `SELECT service,state FROM public.service_state WHERE service<>'programmes'`,
      ),
      fingerprintQuery(
        target,
        `SELECT service,state FROM public.service_state`,
      ),
      source.query<{ programmes: string; total: string }>(`
        SELECT count(*) FILTER (WHERE service='programmes')::text AS programmes,
               count(*)::text AS total
          FROM public.service_state
      `),
      target.query<{ programmes: string; total: string }>(`
        SELECT count(*) FILTER (WHERE service='programmes')::text AS programmes,
               count(*)::text AS total
          FROM public.service_state
      `),
    ]);
  const sourceCount = sourceCounts.rows[0];
  const targetCount = targetCounts.rows[0];
  const identityMatches =
    sourceIdentity.rows === targetIdentity.rows &&
    sourceIdentity.fingerprint === targetIdentity.fingerprint;
  const programmeRemoved =
    Number(sourceCount?.programmes) > 0 &&
    targetCount?.programmes === '0' &&
    Number(sourceCount?.total) ===
      Number(targetCount?.total) + Number(sourceCount?.programmes);
  addCheck(report, 'core', {
    name: 'service-state-programme-normalization',
    status: identityMatches && programmeRemoved ? 'passed' : 'failed',
    source: { identity: sourceIdentity, counts: sourceCount },
    target: { identity: targetIdentity, counts: targetCount },
    detail:
      'The Identity snapshot must be preserved; the Programme snapshot is expected to be removed after normalization.',
  });
}

async function expectedProgrammeEntityTypeCodes(source: Client) {
  return source.query<{ code: string }>(`
    WITH source_codes AS (
      SELECT upper(trim(entry.key)) AS code
        FROM public.service_state AS snapshot
        CROSS JOIN LATERAL jsonb_each(
          CASE WHEN jsonb_typeof(snapshot.state #> '{data,entityTypeCatalog}')='object'
            THEN snapshot.state #> '{data,entityTypeCatalog}' ELSE '{}'::jsonb END
        ) AS entry(key,value)
       WHERE snapshot.service='programmes'
         AND jsonb_typeof(entry.value)='object'
         AND trim(entry.key)<>''
      UNION
      SELECT upper(trim(entity.value->>'code')) AS code
        FROM public.service_state AS snapshot
        CROSS JOIN LATERAL jsonb_each(
          CASE WHEN jsonb_typeof(snapshot.state->'items')='object'
            THEN snapshot.state->'items' ELSE '{}'::jsonb END
        ) AS programme(key,value)
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(programme.value->'entityTypes')='array'
            THEN programme.value->'entityTypes' ELSE '[]'::jsonb END
        ) AS entity(value)
       WHERE snapshot.service='programmes'
         AND jsonb_typeof(programme.value)='object'
         AND jsonb_typeof(entity.value)='object'
         AND COALESCE(trim(entity.value->>'code'),'')<>''
    )
    SELECT DISTINCT code FROM source_codes ORDER BY code
  `);
}

async function compareFingerprints(
  source: Client,
  sourceQuery: string,
  target: Client,
  targetQuery: string,
) {
  const [sourceResult, targetResult] = await Promise.all([
    fingerprintQuery(source, sourceQuery),
    fingerprintQuery(target, targetQuery),
  ]);
  return {
    source: sourceResult,
    target: targetResult,
    matches:
      sourceResult.rows === targetResult.rows &&
      sourceResult.fingerprint === targetResult.fingerprint,
  };
}

async function fingerprintQuery(client: Client, query: string) {
  const result = await client.query<{ rows: string; fingerprint: string }>(`
    SELECT count(*)::text AS rows,
           COALESCE(bit_xor(hashtextextended(to_jsonb(row_value)::text,0)),0)::text AS fingerprint
      FROM (${query}) AS row_value
  `);
  return {
    rows: result.rows[0]?.rows ?? '0',
    fingerprint: result.rows[0]?.fingerprint ?? '0',
  };
}

async function validateActivity(report: ValidationReport, target: Client) {
  const result = await target.query<{ invalidQsoActivations: string }>(`
    SELECT count(*)::text AS "invalidQsoActivations"
      FROM public.activity_qso AS qso
      LEFT JOIN public.activity_activation AS activation
        ON activation.id=qso.activation_id
     WHERE activation.id IS NULL
  `);
  const row = result.rows[0];
  addCheck(report, 'activity', {
    name: 'qso-activation-references',
    status: row?.invalidQsoActivations === '0' ? 'passed' : 'failed',
    target: row,
  });
}

async function validateGeodata(report: ValidationReport, target: Client) {
  const geometry = await target.query<{
    entities: string;
    invalidGeometry: string;
  }>(`
    SELECT count(*)::text AS entities,
           count(*) FILTER (
             WHERE geom IS NULL OR NOT ST_IsValid(geom) OR ST_SRID(geom)<>4326
           )::text AS "invalidGeometry"
      FROM public.geodata_entity
  `);
  const geometryRow = geometry.rows[0];
  addCheck(report, 'geo', {
    name: 'entity-geometry-validity',
    status: geometryRow?.invalidGeometry === '0' ? 'passed' : 'failed',
    target: geometryRow,
  });

  const references = await target.query<{
    orphanAttachments: string;
    orphanCategories: string;
    orphanCandidates: string;
  }>(`
    SELECT
      (SELECT count(*)::text FROM public.geodata_entity_attachment AS attachment
        LEFT JOIN public.geodata_entity AS entity ON entity.id=attachment.entity_id
        WHERE entity.id IS NULL) AS "orphanAttachments",
      (SELECT count(*)::text FROM public.geodata_entity_category AS category
        LEFT JOIN public.geodata_entity AS entity ON entity.id=category.entity_id
        WHERE entity.id IS NULL) AS "orphanCategories",
      (SELECT count(*)::text FROM public.geodata_import_candidate AS candidate
        LEFT JOIN public.import_run AS run ON run.id=candidate.import_run_id
        WHERE run.id IS NULL) AS "orphanCandidates"
  `);
  const referenceRow = references.rows[0];
  const validReferences =
    !!referenceRow &&
    referenceRow.orphanAttachments === '0' &&
    referenceRow.orphanCategories === '0' &&
    referenceRow.orphanCandidates === '0';
  addCheck(report, 'geo', {
    name: 'entity-import-references',
    status: validReferences ? 'passed' : 'failed',
    target: referenceRow,
  });

  const indexes = await target.query<{
    name: string;
    valid: boolean;
    live: boolean;
  }>(`
    SELECT index_class.relname AS name,
           index_info.indisvalid AS valid,
           index_info.indislive AS live
      FROM pg_index AS index_info
      JOIN pg_class AS index_class ON index_class.oid=index_info.indexrelid
     WHERE index_class.relname IN (
       'geodata_entity_geom_idx', 'geodata_entity_geog_idx'
     )
     ORDER BY index_class.relname
  `);
  const requiredIndexes = new Set([
    'geodata_entity_geom_idx',
    'geodata_entity_geog_idx',
  ]);
  const invalidIndexes = indexes.rows.filter(
    (index) => !index.valid || !index.live,
  );
  const missingIndexes = [...requiredIndexes].filter(
    (name) => !indexes.rows.some((index) => index.name === name),
  );
  addCheck(report, 'geo', {
    name: 'postgis-entity-indexes',
    status:
      invalidIndexes.length || missingIndexes.length ? 'failed' : 'passed',
    target: indexes.rows,
    detail: JSON.stringify({ invalidIndexes, missingIndexes }),
  });
}

function addCheck(report: ValidationReport, owner: Owner, check: Check) {
  report.owners[owner].checks.push(check);
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function writeJsonExclusive(path: string, value: unknown) {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Database transfer validation failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
