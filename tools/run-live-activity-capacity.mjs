import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const apiUrls = (process.env.MYOTA_ACTIVITY_CAPACITY_API_URLS ?? '')
  .split(',')
  .map((value) => value.trim().replace(/\/$/, ''))
  .filter(Boolean);
const adminEmail = process.env.MYOTA_ACTIVITY_CAPACITY_ADMIN_EMAIL;
const adminPassword = process.env.MYOTA_ACTIVITY_CAPACITY_ADMIN_PASSWORD;
const loginUrl = process.env.MYOTA_ACTIVITY_CAPACITY_LOGIN_URL;
const databaseUrl = process.env.ACTIVITY_DATABASE_URL;
const natsMonitorUrl = process.env.MYOTA_NATS_MONITOR_URL;
const targetQsoCount = 5_000;

if (
  apiUrls.length !== 2 ||
  !adminEmail ||
  !adminPassword ||
  !loginUrl ||
  !databaseUrl
)
  throw new Error(
    'Set two MYOTA_ACTIVITY_CAPACITY_API_URLS, MYOTA_ACTIVITY_CAPACITY_LOGIN_URL, the admin email/password, and ACTIVITY_DATABASE_URL',
  );

const database = new URL(databaseUrl);
if (!['127.0.0.1', 'localhost', '::1'].includes(database.hostname))
  throw new Error(
    'live Activity qualification requires a loopback database URL',
  );

const pool = new Pool({
  connectionString: databaseUrl,
  max: 12,
  application_name: 'myota-live-activity-capacity',
});
const runId = randomUUID();
const programmeSlug = `live-capacity-${runId}`;
const operatorCallsign = 'EA1CAP';
let activationId;
const awardId = randomUUID();
const startedAt = new Date();
const activationStartedAt = new Date(startedAt.getTime() - 24 * 60 * 60 * 1000);
let bearerToken;
let qsoJobId;
let awardJobId;
let maxActiveConnections = 0;
const maxJetStream = {
  activityWorkMessages: 0,
  activityWorkBytes: 0,
  qsoPending: 0,
  qsoAckPending: 0,
  awardPending: 0,
  awardAckPending: 0,
};
let sampler;

try {
  bearerToken = await login();
  const identityResponse = await request(loginUrl, '/v1/identity/me');
  const operatorId = identityResponse.id;
  if (typeof operatorId !== 'string' || !operatorId)
    throw new Error('authenticated account response did not contain an id');

  for (const apiUrl of apiUrls) {
    const ready = await fetch(`${apiUrl}/readyz`);
    if (!ready.ok)
      throw new Error(`Activity API readiness returned HTTP ${ready.status}`);
  }

  const dbBefore = await databaseStats();
  sampler = setInterval(() => void sample().catch(() => undefined), 500);
  await createActivation(operatorId);
  await createAwardDefinition();

  const qsos = Array.from({ length: targetQsoCount }, (_, index) => {
    const number = String(index).padStart(5, '0');
    return {
      workedCallsign: `J${number}`,
      hunterId: `${runId}-subject-${number}`,
      hunterCallsign: `K${number}`,
      workedEntityId: `ENTITY-${String(index % 1000).padStart(4, '0')}`,
      timestamp: new Date(
        activationStartedAt.getTime() + index * 1_000,
      ).toISOString(),
      band: '20M',
      mode: 'SSB',
    };
  });

  const qsoRequestStarted = performance.now();
  console.log('Submitting the 5,000-QSO workload through Activity API pod 2.');
  const ingestion = await request(apiUrls[1], '/v1/qso-ingestions', {
    method: 'POST',
    headers: { 'Idempotency-Key': randomUUID() },
    body: {
      activationId,
      qsos,
      sourceFormat: 'JSON',
    },
  });
  const qsoAdmissionMilliseconds = Math.round(
    performance.now() - qsoRequestStarted,
  );
  qsoJobId = String(ingestion.ingestionId ?? ingestion.id ?? '');
  if (!qsoJobId) throw new Error('QSO ingestion did not return a job id');
  console.log(
    'Waiting for the deployed Activity worker to complete ingestion.',
  );
  const qsoJob = await waitForJob(`/v1/qso-ingestions/${qsoJobId}`);
  if (qsoJob.status !== 'SUCCEEDED')
    throw new Error(`QSO ingestion finished with ${qsoJob.status}`);

  awardJobId = await broadAwardJobId();
  console.log(
    'Waiting for the deployed Activity worker to complete broad awards.',
  );
  const awardJob = await waitForJob(
    `/v1/awards/${awardId}/recalculation-jobs/${awardJobId}`,
  );
  if (awardJob.status !== 'SUCCEEDED')
    throw new Error(`award recalculation finished with ${awardJob.status}`);

  await waitForRunJobs();
  await sample();
  clearInterval(sampler);
  const dbAfter = await databaseStats();
  const qsoCount = await pool.query(
    `SELECT count(*)::int AS count FROM activity_qso WHERE activation_id=$1::uuid`,
    [activationId],
  );
  const subjectCount = await pool.query(
    `SELECT category,count(*)::int AS count FROM activity_subject_aggregate
      WHERE programme_slug=$1 GROUP BY category ORDER BY category`,
    [programmeSlug],
  );
  const subjectsByCategory = Object.fromEntries(
    subjectCount.rows.map((row) => [row.category, Number(row.count)]),
  );
  const progressCount = await pool.query(
    `SELECT category,count(*)::int AS count FROM activity_award_progress
      WHERE award_id=$1::uuid GROUP BY category ORDER BY category`,
    [awardId],
  );
  const progressByCategory = Object.fromEntries(
    progressCount.rows.map((row) => [row.category, Number(row.count)]),
  );
  if (Number(qsoCount.rows[0]?.count) !== targetQsoCount)
    throw new Error('live QSO count did not match the submitted workload');
  // The operator is included in the broad Hunter result with zero QSOs.
  if ((progressByCategory.HUNTER ?? 0) !== targetQsoCount + 1)
    throw new Error(
      `live award progress was ${JSON.stringify(progressByCategory)}; subjects were ${JSON.stringify(subjectsByCategory)}`,
    );

  console.log(
    JSON.stringify({
      qualification: 'live-activity-capacity',
      measuredAt: new Date().toISOString(),
      topology: { activityApiReplicas: 2, workerReplicas: 1 },
      workload: {
        qsoCount: targetQsoCount,
        activationApiPod: new URL(apiUrls[0]).port,
        ingestionApiPod: new URL(apiUrls[1]).port,
        qsoAdmissionMilliseconds,
        qsoJobLatencyMilliseconds: jobLatency(qsoJob),
        qsoWorkerProcessingMilliseconds: jobProcessing(qsoJob),
        awardJobQueuedBy: 'QSO ingestion',
        awardJobLatencyMilliseconds: jobLatency(awardJob),
        awardWorkerProcessingMilliseconds: jobProcessing(awardJob),
        awardSubjectsCompleted: progressByCategory.HUNTER ?? 0,
        awardProgressByCategory: progressByCategory,
        subjectAggregatesByCategory: subjectsByCategory,
      },
      database: {
        poolMaximum: 12,
        peakActiveConnections: maxActiveConnections,
        statsDelta: databaseStatsDelta(dbBefore, dbAfter),
      },
      jetstream: maxJetStream,
    }),
  );
} finally {
  if (sampler) clearInterval(sampler);
  await cleanup().catch((error) => {
    console.error(
      `Live Activity qualification cleanup failed: ${String(error)}`,
    );
    process.exitCode = 1;
  });
  await pool.end();
}

async function login() {
  const response = await fetch(
    `${loginUrl.replace(/\/$/, '')}/v1/identity/auth/login`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: adminPassword }),
    },
  );
  if (!response.ok)
    throw new Error(`admin login returned HTTP ${response.status}`);
  const body = await response.json();
  if (typeof body.accessToken !== 'string')
    throw new Error('admin login response did not contain an access token');
  return `Bearer ${body.accessToken}`;
}

async function request(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: bearerToken,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      `${options.method ?? 'GET'} ${path} returned HTTP ${response.status}: ${JSON.stringify(body).slice(0, 500)}`,
    );
  return body;
}

async function createActivation(operatorId) {
  const response = await request(apiUrls[0], '/v1/activations', {
    method: 'POST',
    headers: { 'Idempotency-Key': randomUUID() },
    body: {
      programmeSlug,
      entityId: `capacity-${runId}`,
      entityType: 'MUNICIPAL_PARK',
      operatorId,
      operatorCallsign,
      startedAt: activationStartedAt.toISOString(),
    },
  });
  activationId = String(response.id ?? '');
  if (!activationId) throw new Error('activation API did not return an id');
}

async function createAwardDefinition() {
  const definition = {
    id: awardId,
    programmeSlug,
    code: `CAP-${runId.replaceAll('-', '').slice(0, 12)}`,
    version: 1,
    status: 'PUBLISHED',
    category: 'HUNTER',
    achievementMetric: 'QSO_COUNT',
    condition: { kind: 'QSO_COUNT', operator: 'GTE', value: 1 },
    levels: [{ id: 'participant', name: 'Participant', threshold: 1 }],
  };
  await pool.query(
    `INSERT INTO activity_award_definition
       (id,programme_slug,code,version,status,effective_from,definition)
     VALUES ($1,$2,$3,1,'PUBLISHED',now()-interval '1 minute',$4::jsonb)`,
    [awardId, programmeSlug, definition.code, JSON.stringify(definition)],
  );
}

async function waitForJob(path) {
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const job = await request(apiUrls[0], path);
    await sample();
    if (job.status === 'SUCCEEDED' || job.status === 'FAILED') return job;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for job at ${path}`);
}

async function waitForRunJobs() {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT count(*) FILTER (WHERE status IN ('QUEUED','RUNNING'))::int AS active,
              count(*) FILTER (WHERE status='FAILED')::int AS failed
         FROM activity_job WHERE payload->>'programmeSlug'=$1`,
      [programmeSlug],
    );
    if (Number(result.rows[0]?.failed) > 0)
      throw new Error('one or more live Activity qualification jobs failed');
    if (Number(result.rows[0]?.active) === 0) return;
    await sample();
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('timed out waiting for live Activity work to drain');
}

async function broadAwardJobId() {
  const result = await pool.query(
    `SELECT id::text FROM activity_job
      WHERE kind='AWARD_RECALCULATE' AND status<>'FAILED'
        AND payload->>'programmeSlug'=$1
        AND jsonb_array_length(payload->'subjectIds') >= $2
      ORDER BY created_at DESC,id DESC LIMIT 1`,
    [programmeSlug, targetQsoCount],
  );
  const id = result.rows[0]?.id;
  if (typeof id !== 'string')
    throw new Error('QSO ingestion did not create its broad award job');
  return id;
}

async function sample() {
  const connections = await pool.query(
    `SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname=current_database() AND state='active'`,
  );
  maxActiveConnections = Math.max(
    maxActiveConnections,
    Number(connections.rows[0]?.count ?? 0),
  );
  if (!natsMonitorUrl) return;
  const response = await fetch(
    `${natsMonitorUrl.replace(/\/$/, '')}/jsz?streams=true&consumers=true&accounts=true`,
  );
  if (!response.ok) return;
  const status = await response.json();
  const stream = status.account_details
    ?.flatMap((account) => account.stream_detail ?? [])
    .find((candidate) => candidate.name === 'MYOTA_ACTIVITY_WORK');
  if (!stream) return;
  maxJetStream.activityWorkMessages = Math.max(
    maxJetStream.activityWorkMessages,
    Number(stream.state?.messages ?? 0),
  );
  maxJetStream.activityWorkBytes = Math.max(
    maxJetStream.activityWorkBytes,
    Number(stream.state?.bytes ?? 0),
  );
  for (const consumer of stream.consumer_detail ?? []) {
    const name = String(consumer.name ?? '').toLowerCase();
    if (name.includes('qso') || name.includes('adif')) {
      maxJetStream.qsoPending = Math.max(
        maxJetStream.qsoPending,
        Number(consumer.num_pending ?? 0),
      );
      maxJetStream.qsoAckPending = Math.max(
        maxJetStream.qsoAckPending,
        Number(consumer.num_ack_pending ?? 0),
      );
    }
    if (name.includes('award')) {
      maxJetStream.awardPending = Math.max(
        maxJetStream.awardPending,
        Number(consumer.num_pending ?? 0),
      );
      maxJetStream.awardAckPending = Math.max(
        maxJetStream.awardAckPending,
        Number(consumer.num_ack_pending ?? 0),
      );
    }
  }
}

async function databaseStats() {
  const result = await pool.query(
    `SELECT xact_commit::text,tup_inserted::text,tup_updated::text,
            blks_read::text,blks_hit::text,temp_bytes::text
       FROM pg_stat_database WHERE datname=current_database()`,
  );
  if (!result.rows[0]) throw new Error('PostgreSQL returned no database stats');
  return result.rows[0];
}

function databaseStatsDelta(before, after) {
  return Object.fromEntries(
    Object.keys(before).map((key) => [
      key,
      Number(after[key]) - Number(before[key]),
    ]),
  );
}

function jobLatency(job) {
  return job.createdAt && job.completedAt
    ? new Date(job.completedAt).getTime() - new Date(job.createdAt).getTime()
    : null;
}

function jobProcessing(job) {
  return job.startedAt && job.completedAt
    ? new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime()
    : null;
}

async function cleanup() {
  await pool.query('BEGIN');
  try {
    await pool.query(
      `DELETE FROM outbox_event WHERE producer='activity-service'
        AND occurred_at >= $1 AND (
          aggregate_id=$2 OR
          aggregate_id IN (SELECT id::text FROM activity_qso WHERE activation_id=$2::uuid) OR
          aggregate_id IN (SELECT id::text FROM activity_job
                            WHERE payload->>'programmeSlug'=$3)
        )`,
      [startedAt, activationId, programmeSlug],
    );
    await pool.query(
      `DELETE FROM activity_notification WHERE recipient_id LIKE $1`,
      [`${runId}-subject-%`],
    );
    await pool.query(
      'DELETE FROM activity_award_request WHERE programme_slug=$1',
      [programmeSlug],
    );
    await pool.query(
      'DELETE FROM activity_award_progress WHERE award_id=$1::uuid',
      [awardId],
    );
    await pool.query(
      'DELETE FROM activity_subject_aggregate WHERE programme_slug=$1',
      [programmeSlug],
    );
    await pool.query(
      `DELETE FROM activity_job WHERE payload->>'programmeSlug'=$1`,
      [programmeSlug],
    );
    await pool.query('DELETE FROM activity_qso WHERE activation_id=$1::uuid', [
      activationId,
    ]);
    await pool.query(
      'DELETE FROM activity_award_definition WHERE id=$1::uuid',
      [awardId],
    );
    if (activationId)
      await pool.query('DELETE FROM activity_activation WHERE id=$1::uuid', [
        activationId,
      ]);
    await pool.query('COMMIT');
    console.log(`cleaned live Activity capacity fixture ${runId}`);
  } catch (error) {
    await pool.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
