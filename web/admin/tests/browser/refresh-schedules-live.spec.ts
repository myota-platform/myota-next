import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, test } from '@playwright/test';

test('creates and runs a manual snapshot schedule in Admin through live services', async ({
  page,
  request,
}) => {
  test.skip(
    process.env.MYOTA_BROWSER_GEODATA_WORKERS !== '1',
    'requires the CI Geodata workers and JetStream topology',
  );
  const geoDatabaseUrl = process.env.GEO_DATABASE_URL;
  const coreDatabaseUrl = process.env.CORE_DATABASE_URL;
  test.skip(
    !geoDatabaseUrl || !coreDatabaseUrl,
    'requires the isolated Core and Geodata parity databases',
  );
  if (!geoDatabaseUrl || !coreDatabaseUrl) return;

  const geoPool = new Pool({ connectionString: geoDatabaseUrl, max: 1 });
  const geo = await geoPool.connect();
  const corePool = new Pool({ connectionString: coreDatabaseUrl, max: 1 });
  const core = await corePool.connect();
  const fixtureId = randomUUID();
  const categoryCode = `SCHED_${fixtureId.replaceAll('-', '').slice(0, 16).toUpperCase()}`;
  const categoryLabel = `Live schedule category ${fixtureId.slice(0, 8)}`;
  let scheduleId: string | undefined;
  let importRunId: string | undefined;
  const idempotencyKeys: string[] = [];

  page.on('request', (browserRequest) => {
    const key = browserRequest.headers()['idempotency-key'];
    if (key) idempotencyKeys.push(key);
  });

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

    await page.goto('/master-data');
    await expect(page).toHaveURL(/\/login\?redirect=\/master-data$/);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/master-data$/);

    await page.getByRole('button', { name: 'New category' }).click();
    await page.getByLabel('Category code').fill(categoryCode);
    await page.getByLabel('Display name').fill(categoryLabel);
    await page.getByRole('checkbox', { name: 'Point', exact: true }).check();
    await page
      .getByLabel('Description')
      .fill('Refresh schedule browser fixture.');
    await page.getByRole('button', { name: 'Save category' }).click();
    await expect(page.getByText('Category saved.')).toBeVisible();

    await page.goto('/refresh-schedules');
    await expect(page).toHaveURL(/\/refresh-schedules$/);
    await expect(page.getByLabel(categoryLabel)).toBeVisible();
    await page.getByLabel(categoryLabel).check();
    await page
      .getByLabel('Source settings (JSON object)')
      .fill(
        JSON.stringify({ name: 'Live Admin schedule', sourceKey: fixtureId }),
      );
    const [createResponse] = await Promise.all([
      page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === '/v1/geodata/refresh-schedules' &&
          response.request().method() === 'POST'
        );
      }),
      page.getByRole('button', { name: 'Create schedule' }).click(),
    ]);
    expect(createResponse.status()).toBe(201);
    const schedule = await createResponse.json();
    scheduleId = schedule.id as string;
    expect(schedule).toMatchObject({
      programmeSlug: null,
      adapter: 'MANUAL',
      entityTypes: [categoryCode],
      source: { name: 'Live Admin schedule', sourceKey: fixtureId },
      intervalSeconds: 86_400,
      disappearancePolicy: 'REVIEW_REQUIRED',
      enabled: true,
    });
    await expect(page.getByText('Refresh schedule created.')).toBeVisible();

    await page.getByLabel('Manual complete snapshot (GeoJSON)').setInputFiles({
      name: 'empty-snapshot.geojson',
      mimeType: 'application/geo+json',
      buffer: Buffer.from(
        JSON.stringify({ type: 'FeatureCollection', features: [] }),
      ),
    });
    const [runResponse] = await Promise.all([
      page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === `/v1/geodata/refresh-schedules/${scheduleId}/run` &&
          response.request().method() === 'POST'
        );
      }),
      page.getByRole('button', { name: 'Run with snapshot' }).click(),
    ]);
    expect(runResponse.status()).toBe(202);
    const queued = await runResponse.json();
    importRunId = queued.id as string;
    await expect(page.getByRole('status')).toContainText(
      `Import ${importRunId}.`,
    );

    const deadline = Date.now() + 60_000;
    let importStatus = 'QUEUED';
    const activeStatuses = new Set([
      'QUEUED',
      'PROCESSING',
      'PREPROCESSED',
      'PREPROCESSED_WITH_ERRORS',
    ]);
    while (Date.now() < deadline && activeStatuses.has(importStatus)) {
      const status = await request.get(
        `http://127.0.0.1:8080/v1/geodata/imports/${importRunId}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      const statusBody = await status.json();
      expect(status.status()).toBe(200);
      importStatus = statusBody.status as string;
      if (importStatus !== 'COMPLETED')
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(importStatus).toBe('COMPLETED');

    const persisted = await geo.query<{
      status: string;
      complete_snapshot: boolean;
      record_count: string;
      queue_status: string;
    }>(
      `SELECT r.status,r.complete_snapshot,m.record_count::text AS record_count,
              q.status AS queue_status
         FROM import_run r
         JOIN source_snapshot_manifest m ON m.import_run_id=r.id
         JOIN geodata_import_processing_queue q ON q.import_run_id=r.id
        WHERE r.id=$1::uuid`,
      [importRunId],
    );
    expect(persisted.rows).toEqual([
      {
        status: 'COMPLETED',
        complete_snapshot: true,
        record_count: '0',
        queue_status: 'COMPLETED',
      },
    ]);
  } finally {
    try {
      try {
        await geo.query('BEGIN');
        await geo.query(
          "SELECT set_config('myota.geodata_writer','row-v1',true)",
        );
        if (scheduleId)
          await geo.query(
            `DELETE FROM outbox_event
              WHERE aggregate_type='refresh_schedule' AND aggregate_id=$1`,
            [scheduleId],
          );
        if (importRunId) {
          await geo.query(
            `DELETE FROM outbox_event
              WHERE (aggregate_type='import_run' AND aggregate_id=$1)
                 OR (aggregate_type='import_processing_queue' AND aggregate_id IN
                   (SELECT id::text FROM geodata_import_processing_queue
                     WHERE import_run_id=$1::uuid))`,
            [importRunId],
          );
          await geo.query(
            'DELETE FROM source_snapshot_manifest WHERE import_run_id=$1::uuid',
            [importRunId],
          );
          await geo.query(
            'DELETE FROM geodata_import_candidate_stage WHERE import_run_id=$1::uuid',
            [importRunId],
          );
          await geo.query('DELETE FROM import_run WHERE id=$1::uuid', [
            importRunId,
          ]);
          await geo.query(
            `DELETE FROM idempotency_record
              WHERE service IN ('geodata-schedule-run','geodata-service')
                AND response->>'id'=$1`,
            [importRunId],
          );
        }
        if (scheduleId) {
          await geo.query(
            "DELETE FROM geodata_control_record WHERE kind='schedules' AND id=$1",
            [scheduleId],
          );
          await geo.query(
            `DELETE FROM idempotency_record
              WHERE service='geodata-schedule-create' AND response->>'id'=$1`,
            [scheduleId],
          );
        }
        await geo.query('COMMIT');
      } catch (error) {
        await geo.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        geo.release();
        await geoPool.end();
      }
    } finally {
      try {
        await core.query('BEGIN');
        await core.query(
          `DELETE FROM outbox_event
            WHERE producer='programmes' AND aggregate_id=$1`,
          [categoryCode],
        );
        await core.query(
          "DELETE FROM idempotency_record WHERE service='programmes' AND key=ANY($1::text[])",
          [idempotencyKeys],
        );
        await core.query('DELETE FROM programme_entity_type WHERE code=$1', [
          categoryCode,
        ]);
        await core.query('COMMIT');
      } catch (error) {
        await core.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        core.release();
        await corePool.end();
      }
    }
  }
});
