import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, test } from '@playwright/test';

const hasApiDatabases = Boolean(
  process.env.CORE_DATABASE_URL &&
  process.env.ACTIVITY_DATABASE_URL &&
  process.env.GEO_DATABASE_URL,
);

test('serves public Activity history, leaderboard, and result exports', async ({
  request,
}) => {
  test.skip(!hasApiDatabases, 'requires the CI PostgreSQL databases');

  const pool = new Pool({
    connectionString: process.env.ACTIVITY_DATABASE_URL,
    max: 1,
  });
  const fixtureId = randomUUID();
  const programmeSlug = `browser-public-activity-${fixtureId}`;
  const entityId = `browser-public-entity-${fixtureId}`;
  const subjectId = `browser-public-subject-${fixtureId}`;
  let activationId: string | undefined;

  try {
    const email =
      process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL ??
      'browser-e2e-admin@example.test';
    const password =
      process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD ?? 'browser-e2e-password-7!Q';
    const login = await request.post(
      'http://127.0.0.1:8080/v1/identity/auth/login',
      { data: { email, password } },
    );
    expect(login.ok()).toBeTruthy();
    const { accessToken } = await login.json();
    const headers = { Authorization: `Bearer ${accessToken}` };
    const identity = await request.get('http://127.0.0.1:8080/v1/identity/me', {
      headers,
    });
    expect(identity.ok()).toBeTruthy();
    const operatorId = (await identity.json()).id as string;

    const activation = await request.post(
      'http://127.0.0.1:8080/v1/activations',
      {
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        data: {
          programmeSlug,
          entityId,
          operatorId,
          operatorCallsign: 'N0CALL',
          startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          programmeRules: { activationValidityDays: 7 },
        },
      },
    );
    expect(activation.status()).toBe(201);
    activationId = (await activation.json()).id as string;

    await pool.query(
      `INSERT INTO activity_subject_aggregate
       (programme_slug,subject_id,category,qso_count,activation_count,unique_callsign_count,unique_entity_count)
       VALUES ($1,$2,'HUNTER',3,2,4,5)`,
      [programmeSlug, subjectId],
    );

    const history = await request.get(
      `http://127.0.0.1:8080/v1/public/activations?programme=${encodeURIComponent(programmeSlug)}&page=1&pageSize=1`,
    );
    expect(history.status()).toBe(200);
    expect(await history.json()).toMatchObject({
      page: 1,
      pageSize: 1,
      total: 1,
      nextPage: null,
      items: [
        {
          id: activationId,
          operatorCallsign: 'N0***L',
        },
      ],
    });

    const leaderboard = await request.get(
      `http://127.0.0.1:8080/v1/public/leaderboards?programme=${encodeURIComponent(programmeSlug)}&category=hunter`,
    );
    expect(leaderboard.status()).toBe(200);
    expect(await leaderboard.json()).toEqual({
      programme: programmeSlug,
      category: 'HUNTER',
      items: [
        {
          subject_id: subjectId,
          qso_count: 3,
          activation_count: 2,
          unique_callsign_count: 4,
          unique_entity_count: 5,
        },
      ],
    });

    const results = await request.get(
      `http://127.0.0.1:8080/v1/public/results?programme=${encodeURIComponent(programmeSlug)}`,
    );
    expect(results.status()).toBe(200);
    expect(await results.json()).toMatchObject({
      format: 'json',
      downloadName: `myota-results-${programmeSlug}.json`,
      items: [
        {
          activationId,
          programme: programmeSlug,
          entityId,
          status: 'OPEN',
          qsoCount: 0,
        },
      ],
    });

    const csv = await request.get(
      `http://127.0.0.1:8080/v1/public/results?programme=${encodeURIComponent(programmeSlug)}&format=csv`,
    );
    expect(csv.status()).toBe(200);
    const csvResult = await csv.json();
    expect(csvResult).toMatchObject({
      format: 'csv',
      contentType: 'text/csv',
      downloadName: `myota-results-${programmeSlug}.csv`,
    });
    const csvContent = csvResult.content as string;
    expect(csvContent.split('\n')[0]).toBe(
      'activationId,programme,entityId,status,startedAt,qsoCount',
    );
    expect(csvContent).toContain(
      `${activationId},${programmeSlug},${entityId},OPEN,`,
    );
  } finally {
    await pool.query(
      'DELETE FROM activity_subject_aggregate WHERE programme_slug=$1 AND subject_id=$2',
      [programmeSlug, subjectId],
    );
    if (activationId) {
      await pool.query('DELETE FROM outbox_event WHERE aggregate_id=$1', [
        activationId,
      ]);
      await pool.query('DELETE FROM activity_activation WHERE id=$1', [
        activationId,
      ]);
    }
    await pool.end();
  }
});
