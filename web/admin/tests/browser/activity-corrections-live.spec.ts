import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, test } from '@playwright/test';

test('reviews live QSO corrections without changing rejected QSOs', async ({
  page,
}) => {
  const databaseUrl = process.env.ACTIVITY_DATABASE_URL;
  test.skip(!databaseUrl, 'requires the isolated Activity parity database');
  if (!databaseUrl) return;

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const fixtureId = randomUUID();
  const programmeSlug = `browser-correction-${fixtureId}`;
  const activationId = randomUUID();
  const qsoIds = [randomUUID(), randomUUID()];
  const correctionIds = [randomUUID(), randomUUID()];
  const initialCalls = ['F4XYY', 'G4ABC'];

  try {
    await pool.query(
      `INSERT INTO activity_activation
         (id,programme_slug,entity_id,entity_type,jurisdiction_code,
          operator_id,operator_callsign,started_at,status)
       VALUES ($1,$2,$3,'SOTA','CH','correction-operator','DL1CORR',now(),'OPEN')`,
      [activationId, programmeSlug, `correction-entity-${fixtureId}`],
    );

    for (const [index, qsoId] of qsoIds.entries()) {
      await pool.query(
        `INSERT INTO activity_qso
           (id,activation_id,programme_slug,operator_id,operator_callsign,
            worked_callsign,worked_station_key,occurred_at,band,mode,
            deduplication_key)
         VALUES ($1,$2,$3,'correction-operator','DL1CORR',$4,$4,now(),$5,$6,$7)`,
        [
          qsoId,
          activationId,
          programmeSlug,
          initialCalls[index],
          index === 0 ? '20M' : '40M',
          index === 0 ? 'SSB' : 'CW',
          randomUUID(),
        ],
      );
      await pool.query(
        `INSERT INTO activity_qso_correction
           (id,qso_id,requested_by,reason,proposed_values)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [
          correctionIds[index],
          qsoId,
          `correction-requester-${index + 1}`,
          index === 0
            ? 'Correct the worked callsign'
            : 'Reject the proposed callsign',
          JSON.stringify({ workedCallsign: index === 0 ? 'F4XYZ' : 'G4NOT' }),
        ],
      );
    }

    const adminEmail =
      process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL ??
      'browser-e2e-admin@example.test';
    const adminPassword =
      process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD ?? 'browser-e2e-password-7!Q';
    const confirmations: string[] = [];
    page.on('dialog', async (dialog) => {
      confirmations.push(dialog.message());
      await dialog.accept();
    });

    await page.goto('/activity');
    await expect(page).toHaveURL(/\/login\?redirect=\/activity$/);
    await page.getByLabel('Email').fill(adminEmail);
    await page.getByLabel('Password').fill(adminPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/activity$/);

    const appliedCard = page
      .locator('.correction-card')
      .filter({ hasText: initialCalls[0] });
    const rejectedCard = page
      .locator('.correction-card')
      .filter({ hasText: initialCalls[1] });
    await expect(appliedCard).toContainText('Correct the worked callsign');
    await expect(rejectedCard).toContainText('Reject the proposed callsign');

    await appliedCard
      .getByLabel('Review note (optional)')
      .fill('Verified against the station log');
    const appliedResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/v1/qsos/${qsoIds[0]}/corrections/${correctionIds[0]}/review` &&
        response.request().method() === 'POST',
    );
    await appliedCard.getByRole('button', { name: 'Apply correction' }).click();
    expect((await appliedResponse).status()).toBe(200);
    await expect(page.getByText('QSO correction applied.')).toBeVisible();

    await rejectedCard
      .getByLabel('Review note (optional)')
      .fill('The station log confirms G4ABC');
    const rejectedResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/v1/qsos/${qsoIds[1]}/corrections/${correctionIds[1]}/review` &&
        response.request().method() === 'POST',
    );
    await rejectedCard.getByRole('button', { name: 'Reject' }).click();
    expect((await rejectedResponse).status()).toBe(200);
    await expect(page.getByText('QSO correction rejected.')).toBeVisible();

    const records = await pool.query<{
      qso_id: string;
      worked_callsign: string;
      qso_status: string;
      correction_status: string;
      review_note: string;
    }>(
      `SELECT q.id AS qso_id,q.worked_callsign,q.status AS qso_status,
              c.status AS correction_status,c.review_note
         FROM activity_qso q
         JOIN activity_qso_correction c ON c.qso_id=q.id
        WHERE c.id=ANY($1::uuid[])
        ORDER BY c.id`,
      [correctionIds],
    );
    expect(records.rows).toHaveLength(2);
    const byCorrection = new Map(
      records.rows.map((record) => [record.qso_id, record]),
    );
    expect(byCorrection.get(qsoIds[0])).toMatchObject({
      worked_callsign: 'F4XYZ',
      qso_status: 'CORRECTED',
      correction_status: 'APPLIED',
      review_note: 'Verified against the station log',
    });
    expect(byCorrection.get(qsoIds[1])).toMatchObject({
      worked_callsign: 'G4ABC',
      qso_status: 'VALID',
      correction_status: 'REJECTED',
      review_note: 'The station log confirms G4ABC',
    });
    expect(confirmations).toHaveLength(2);

    const jobs = await pool.query<{ id: string }>(
      `SELECT id FROM activity_job
        WHERE kind='AWARD_RECALCULATE'
          AND payload->>'programmeSlug'=$1`,
      [programmeSlug],
    );
    expect(jobs.rows).toHaveLength(1);
  } finally {
    const jobs = await pool.query<{ id: string }>(
      `SELECT id FROM activity_job
        WHERE kind='AWARD_RECALCULATE'
          AND payload->>'programmeSlug'=$1`,
      [programmeSlug],
    );
    const jobIds = jobs.rows.map((row) => row.id);
    if (jobIds.length) {
      await pool.query(
        `DELETE FROM outbox_event
          WHERE producer='activity-service' AND aggregate_type='activity_job'
            AND aggregate_id=ANY($1::text[])`,
        [jobIds],
      );
      await pool.query('DELETE FROM activity_job WHERE id=ANY($1::uuid[])', [
        jobIds,
      ]);
    }
    await pool.query(
      'DELETE FROM activity_qso_correction WHERE id=ANY($1::uuid[])',
      [correctionIds],
    );
    await pool.query('DELETE FROM activity_qso WHERE id=ANY($1::uuid[])', [
      qsoIds,
    ]);
    await pool.query('DELETE FROM activity_activation WHERE id=$1::uuid', [
      activationId,
    ]);
    await pool.end();
  }
});
