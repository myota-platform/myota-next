import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, test, type Page } from '@playwright/test';
import { expectResponsiveAccessible } from '../../a11y';

const hasApiDatabases = Boolean(
  process.env.CORE_DATABASE_URL &&
  process.env.ACTIVITY_DATABASE_URL &&
  process.env.GEO_DATABASE_URL,
);

test('uploads and processes an ADIF import from Participant through Activity workers', async ({
  page,
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
    const programme = {
      slug: programmeSlug,
      name: 'ADIF upload test programme',
      description: 'Participant ADIF upload browser fixture.',
      theme: { primary: '#2367a8', accent: '#e38a32' },
      rules: {
        activationValidityDays: 7,
        minimumQsos: { activation: 1, hunter: 1 },
        publicAccessRequired: false,
      },
      entityTypes: [],
    };
    await page.route('**/v1/programmes**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/content')) {
        await route.fulfill({ json: { items: [] } });
        return;
      }
      await route.fulfill({
        json: { items: [programme], page: 1, total: 1, nextPage: null },
      });
    });
    await page.route('**/v1/geodata/entities**', (route) =>
      route.fulfill({
        json: { items: [], page: 1, total: 0, nextPage: null },
      }),
    );
    await page.goto(`http://127.0.0.1:8091/#${programmeSlug}`);
    await expect(page.locator('#programme-select')).toHaveValue(programmeSlug);
    await page.locator('#award-email').fill(email);
    await page.locator('#award-password').fill(password);
    await page.locator('#participant-login button[type="submit"]').click();
    await expect(page.locator('#qso-form')).toBeVisible();
    await expect(page.locator('#adif-import-form')).toBeVisible();

    const filename = `live-${fixtureId}.adi`;
    const adif =
      `<ADIF_VER:5>3.1.4<EOH><CALL:5>F4ABC<QSO_DATE:8>${qsoDate}` +
      `<TIME_ON:6>${timeOn}<BAND:3>20m<MODE:3>SSB<EOR>`;
    await submitAdifWithKeyboard(page, {
      name: filename,
      mimeType: 'text/plain',
      buffer: Buffer.from(adif),
    });
    await expect(page.locator('#adif-import-status')).toContainText(
      `${filename}: COMPLETED · 1 accepted, 0 rejected`,
      { timeout: 60_000 },
    );
    await expectResponsiveAccessible(
      page,
      'Live Participant ADIF import status',
    );

    const importIdInSession = await page.evaluate(() =>
      sessionStorage.getItem('myota_active_adif_import'),
    );
    expect(importIdInSession).toBeNull();
    const imports = await pool.query<{ id: string }>(
      `SELECT id::text FROM activity_import WHERE activation_id=$1`,
      [activationId],
    );
    expect(imports.rows).toHaveLength(1);
    importId = imports.rows[0].id;

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

    const invalidUtf8Filename = `invalid-utf8-${fixtureId}.adi`;
    await submitAdifWithKeyboard(page, {
      name: invalidUtf8Filename,
      mimeType: 'text/plain',
      buffer: Buffer.from([0xff, 0xfe, 0x00]),
    });
    await expect(page.locator('#adif-import-status')).toContainText(
      `${invalidUtf8Filename}: FAILED · 0 accepted, 1 rejected`,
      { timeout: 60_000 },
    );
    await expectResponsiveAccessible(
      page,
      'Live Participant failed ADIF import status and recovery',
    );

    const failedImport = await pool.query<{
      id: string;
      status: string;
      records_seen: number;
      records_accepted: number;
      records_rejected: number;
      errors: string[];
    }>(
      `SELECT id::text,status,records_seen,records_accepted,records_rejected,errors
       FROM activity_import WHERE activation_id=$1 AND filename=$2`,
      [activationId, invalidUtf8Filename],
    );
    expect(failedImport.rows).toHaveLength(1);
    const failedImportId = failedImport.rows[0].id;
    expect(failedImport.rows[0]).toMatchObject({
      id: failedImportId,
      status: 'FAILED',
      records_seen: 0,
      records_accepted: 0,
      records_rejected: 1,
    });
    expect(failedImport.rows[0].errors).toHaveLength(1);
    expect(failedImport.rows[0].errors[0]).toMatch(/.+/);

    const failedNotification = await pool.query<{
      notification_type: string;
      payload: { importId: string };
    }>(
      `SELECT notification_type,payload FROM activity_notification
       WHERE deduplication_key=$1`,
      [`adif:${failedImportId}:failed`],
    );
    expect(failedNotification.rows).toMatchObject([
      {
        notification_type: 'ADIF_IMPORT_FAILED',
        payload: { importId: failedImportId },
      },
    ]);

    const retryFilename = `retry-${fixtureId}.adi`;
    const retryAdif =
      `<ADIF_VER:5>3.1.4<EOH><CALL:5>F4DEF<QSO_DATE:8>${qsoDate}` +
      `<TIME_ON:6>${timeOn}<BAND:3>20m<MODE:3>SSB<EOR>`;
    await submitAdifWithKeyboard(page, {
      name: retryFilename,
      mimeType: 'text/plain',
      buffer: Buffer.from(retryAdif),
    });
    await expect(page.locator('#adif-import-status')).toContainText(
      `${retryFilename}: COMPLETED · 1 accepted, 0 rejected`,
      { timeout: 60_000 },
    );

    const retriedImport = await pool.query<{
      id: string;
      status: string;
      records_seen: number;
      records_accepted: number;
      records_rejected: number;
    }>(
      `SELECT id::text,status,records_seen,records_accepted,records_rejected
       FROM activity_import WHERE activation_id=$1 AND filename=$2`,
      [activationId, retryFilename],
    );
    expect(retriedImport.rows).toMatchObject([
      {
        status: 'COMPLETED',
        records_seen: 1,
        records_accepted: 1,
        records_rejected: 0,
      },
    ]);
    const retriedQso = await pool.query<{
      worked_callsign: string;
      source_import_id: string;
    }>(
      `SELECT worked_callsign,source_import_id::text FROM activity_qso
       WHERE source_import_id=$1`,
      [retriedImport.rows[0].id],
    );
    expect(retriedQso.rows).toEqual([
      {
        worked_callsign: 'F4DEF',
        source_import_id: retriedImport.rows[0].id,
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
            OR aggregate_id IN (
              SELECT id::text FROM activity_import WHERE activation_id=$2
            )
            OR payload->>'jobId' IN (
              SELECT id::text FROM activity_job
              WHERE payload->>'importId' IN (
                SELECT id::text FROM activity_import WHERE activation_id=$2
              ) OR payload->>'programmeSlug'=$3
            )`,
        [[activationId], activationId, programmeSlug],
      );
      await pool.query(
        `DELETE FROM activity_job
         WHERE payload->>'importId' IN (
           SELECT id::text FROM activity_import WHERE activation_id=$1
         ) OR payload->>'programmeSlug'=$2`,
        [activationId, programmeSlug],
      );
      await pool.query(
        `DELETE FROM activity_notification
         WHERE payload->>'importId' IN (
           SELECT id::text FROM activity_import WHERE activation_id=$1
         )`,
        [activationId],
      );
      await pool.query('DELETE FROM activity_import WHERE activation_id=$1', [
        activationId,
      ]);
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

async function submitAdifWithKeyboard(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
) {
  const input = page.locator('#adif-file');
  await input.setInputFiles(file);
  await input.focus();
  await page.keyboard.press('Tab');
  const submit = page.getByRole('button', { name: 'Import ADIF log' });
  await expect(submit).toBeFocused();
  await page.keyboard.press('Enter');
}
