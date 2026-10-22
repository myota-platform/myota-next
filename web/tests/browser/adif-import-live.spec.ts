import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, test } from '@playwright/test';

const hasApiDatabases = Boolean(
  process.env.CORE_DATABASE_URL &&
  process.env.ACTIVITY_DATABASE_URL &&
  process.env.GEO_DATABASE_URL,
);

test('uploads and processes an ADIF import through Gateway and Activity workers', async ({
  request,
}) => {
  test.skip(!hasApiDatabases, 'requires the CI PostgreSQL databases');

  const pool = new Pool({
    connectionString: process.env.ACTIVITY_DATABASE_URL,
    max: 1,
  });
  const fixtureId = randomUUID();
  const programmeSlug = `browser-adif-${fixtureId}`;
  const startedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  let activationId: string | undefined;
  let importId: string | undefined;
  let accountId: string | undefined;

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
    accountId = (await identity.json()).id as string;

    const activationResponse = await request.post(
      'http://127.0.0.1:8080/v1/activations',
      {
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        data: {
          programmeSlug,
          entityId: `browser-entity-${fixtureId}`,
          operatorId: accountId,
          operatorCallsign: 'N0CALL',
          startedAt,
          programmeRules: { activationValidityDays: 7 },
        },
      },
    );
    expect(activationResponse.status()).toBe(201);
    activationId = (await activationResponse.json()).id as string;

    const qsoTime = new Date(Date.now() - 5 * 60_000);
    const qsoDate = qsoTime.toISOString().slice(0, 10).replaceAll('-', '');
    const timeOn = qsoTime.toISOString().slice(11, 19).replaceAll(':', '');
    const adif =
      `<ADIF_VER:5>3.1.4<EOH><CALL:5>F4ABC<QSO_DATE:8>${qsoDate}` +
      `<TIME_ON:6>${timeOn}<BAND:3>20m<MODE:3>SSB<EOR>`;
    const upload = await request.post('http://127.0.0.1:8080/v1/adif/imports', {
      headers,
      data: {
        activationId,
        filename: `live-${fixtureId}.adi`,
        contentBase64: Buffer.from(adif).toString('base64'),
      },
    });
    expect(upload.status()).toBe(202);
    importId = (await upload.json()).id as string;

    await expect
      .poll(
        async () => {
          const status = await request.get(
            `http://127.0.0.1:8080/v1/adif/imports/${importId}`,
          );
          expect(status.ok()).toBeTruthy();
          return (await status.json()).status;
        },
        { timeout: 60_000 },
      )
      .toBe('COMPLETED');

    const imported = await pool.query<{
      status: string;
      records_seen: number;
      records_accepted: number;
      records_rejected: number;
    }>(
      `SELECT status,records_seen,records_accepted,records_rejected
       FROM activity_import WHERE id=$1`,
      [importId],
    );
    expect(imported.rows[0]).toMatchObject({
      status: 'COMPLETED',
      records_seen: 1,
      records_accepted: 1,
      records_rejected: 0,
    });

    const qso = await pool.query<{
      worked_callsign: string;
      band: string;
      mode: string;
      source: string;
      source_import_id: string;
    }>(
      `SELECT worked_callsign,band,mode,source,source_import_id::text
       FROM activity_qso WHERE source_import_id=$1`,
      [importId],
    );
    expect(qso.rows).toEqual([
      {
        worked_callsign: 'F4ABC',
        band: '20M',
        mode: 'SSB',
        source: 'adif',
        source_import_id: importId,
      },
    ]);

    const notification = await pool.query<{
      notification_type: string;
      recipient_id: string;
      payload: { importId: string };
    }>(
      `SELECT notification_type,recipient_id,payload
       FROM activity_notification WHERE deduplication_key=$1`,
      [`adif:${importId}:completed`],
    );
    expect(notification.rows).toMatchObject([
      {
        notification_type: 'ADIF_IMPORT_COMPLETED',
        recipient_id: accountId,
        payload: { importId },
      },
    ]);
  } finally {
    if (activationId) {
      await pool.query(
        `DELETE FROM activity_qso_correction c USING activity_qso q
         WHERE c.qso_id=q.id AND q.activation_id=$1`,
        [activationId],
      );
      await pool.query('DELETE FROM activity_qso WHERE activation_id=$1', [
        activationId,
      ]);
      await pool.query(
        `DELETE FROM outbox_event
         WHERE aggregate_id=ANY($1::text[])
            OR payload->>'jobId' IN (
              SELECT id::text FROM activity_job
              WHERE payload->>'importId'=$2 OR payload->>'programmeSlug'=$3
            )`,
        [
          [activationId, ...(importId ? [importId] : [])],
          importId ?? '',
          programmeSlug,
        ],
      );
      await pool.query('DELETE FROM activity_import WHERE activation_id=$1', [
        activationId,
      ]);
      await pool.query(
        `DELETE FROM activity_job
         WHERE payload->>'importId'=$1 OR payload->>'programmeSlug'=$2`,
        [importId ?? '', programmeSlug],
      );
      await pool.query(
        `DELETE FROM activity_notification
         WHERE deduplication_key=$1 OR payload->>'importId'=$2`,
        [`adif:${importId ?? ''}:completed`, importId ?? ''],
      );
      await pool.query(
        `DELETE FROM activity_subject_callsign
         WHERE programme_slug=$1 AND subject_id=$2`,
        [programmeSlug, accountId ?? ''],
      );
      await pool.query(
        `DELETE FROM activity_subject_entity
         WHERE programme_slug=$1 AND subject_id=$2`,
        [programmeSlug, accountId ?? ''],
      );
      await pool.query(
        `DELETE FROM activity_subject_aggregate
         WHERE programme_slug=$1 AND subject_id=$2`,
        [programmeSlug, accountId ?? ''],
      );
      await pool.query('DELETE FROM activity_activation WHERE id=$1', [
        activationId,
      ]);
    }
    await pool.end();
  }
});
