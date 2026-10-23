import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, test } from '@playwright/test';

test('deletes an entity and reconciles linked Activity data through live services', async ({
  page,
}) => {
  test.skip(
    process.env.MYOTA_BROWSER_GEODATA_WORKERS !== '1',
    'requires the CI Geodata workers and JetStream topology',
  );
  const geodataUrl = process.env.GEO_DATABASE_URL;
  const activityUrl = process.env.ACTIVITY_DATABASE_URL;
  test.skip(!geodataUrl || !activityUrl, 'requires isolated owner databases');
  if (!geodataUrl || !activityUrl) return;

  const entityId = randomUUID();
  const activationId = randomUUID();
  const qsoId = randomUUID();
  const correctionId = randomUUID();
  const entityName = `Live deletion fixture ${entityId}`;
  const programmeSlug = `browser-delete-${entityId.slice(0, 8)}`;
  const operatorId = `browser-delete-operator-${entityId}`;
  const geodataPool = new Pool({ connectionString: geodataUrl, max: 1 });
  const activityPool = new Pool({ connectionString: activityUrl, max: 1 });
  const geodata = await geodataPool.connect();
  const activity = await activityPool.connect();
  try {
    await geodata.query('BEGIN');
    await geodata.query(
      "SELECT set_config('myota.geodata_writer','row-v1',true)",
    );
    await geodata.query(
      `INSERT INTO geodata_entity
         (id,name,lifecycle_status,geom,programme_slug,entity_type_code)
       VALUES ($1,$2,'APPROVED',ST_SetSRID(ST_MakePoint(7.2,46.1),4326),$3,'SOTA')`,
      [entityId, entityName, programmeSlug],
    );
    await geodata.query('COMMIT');

    await activity.query('BEGIN');
    await activity.query(
      `INSERT INTO activity_activation
         (id,programme_slug,entity_id,entity_type,jurisdiction_code,
          operator_id,operator_callsign,started_at,status)
       VALUES ($1,$2,$3,'SOTA','CH',$4,'HB9TEST',now(),'OPEN')`,
      [activationId, programmeSlug, entityId, operatorId],
    );
    await activity.query(
      `INSERT INTO activity_qso
         (id,activation_id,programme_slug,operator_id,operator_callsign,
          hunter_id,hunter_callsign,worked_callsign,worked_station_key,
          worked_entity_id,occurred_at,deduplication_key)
       VALUES ($1,$2,$3,$4,'HB9TEST','browser-delete-hunter','DL1TEST',
          'DL1TEST',$5,$6,now(),$7)`,
      [
        qsoId,
        activationId,
        programmeSlug,
        operatorId,
        randomUUID(),
        entityId,
        randomUUID(),
      ],
    );
    await activity.query(
      `INSERT INTO activity_qso_correction
         (id,qso_id,requested_by,reason,proposed_values)
       VALUES ($1,$2,$3,'browser deletion fixture','{}'::jsonb)`,
      [correctionId, qsoId, operatorId],
    );
    await activity.query('COMMIT');

    await page.goto('/entity-management');
    await expect(page).toHaveURL(/\/login\?redirect=\/entity-management$/);
    await page
      .getByLabel('Email')
      .fill(
        process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL ??
          'browser-e2e-admin@example.test',
      );
    await page
      .getByLabel('Password')
      .fill(
        process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD ??
          'browser-e2e-password-7!Q',
      );
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/entity-management$/);

    await page
      .locator('button.entity-link')
      .filter({ hasText: entityName })
      .click();
    await page.getByRole('button', { name: 'Audit & deletion' }).click();
    await page
      .getByRole('button', { name: 'Permanently delete entity' })
      .click();
    const dialog = page.getByRole('dialog', {
      name: `Delete ${entityName}?`,
    });
    await expect(dialog).toContainText(
      '1 valid QSO(s) will be deleted in cascade.',
    );
    await expect(dialog).toContainText('1 activation(s) may become invalid.');
    await dialog
      .getByRole('button', { name: 'Permanently delete entity' })
      .click();
    await expect(
      page.getByText(
        'Entity permanently deleted; linked activity and award progress were reconciled.',
      ),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator('button.entity-link').filter({ hasText: entityName }),
    ).toHaveCount(0);

    const geodataState = await geodata.query(
      `SELECT
         (SELECT count(*)::text FROM geodata_entity WHERE id=$1::uuid) AS entities,
         (SELECT payload->>'status' FROM geodata_control_record
            WHERE kind='entityDeletionJobs' AND payload->>'entityId'=$1::text
            ORDER BY updated_at DESC LIMIT 1) AS job_status`,
      [entityId],
    );
    expect(geodataState.rows[0]).toMatchObject({
      entities: '0',
      job_status: 'COMPLETED',
    });

    const activityState = await activity.query(
      `SELECT
         (SELECT count(*)::text FROM activity_qso WHERE id=$1) AS qsos,
         (SELECT count(*)::text FROM activity_qso_correction WHERE id=$2) AS corrections,
         (SELECT status FROM activity_activation WHERE id=$3) AS activation_status,
         (SELECT qso_count::text FROM activity_activation WHERE id=$3) AS activation_qsos,
         (SELECT count(*)::text FROM activity_job
            WHERE idempotency_key=$4) AS recalculation_jobs`,
      [
        qsoId,
        correctionId,
        activationId,
        `entity-delete-awards:${entityId}:${programmeSlug}`,
      ],
    );
    expect(activityState.rows[0]).toEqual({
      qsos: '0',
      corrections: '0',
      activation_status: 'CLOSED_INVALID',
      activation_qsos: '0',
      recalculation_jobs: '1',
    });
  } finally {
    await geodata.query('ROLLBACK').catch(() => undefined);
    await activity.query('ROLLBACK').catch(() => undefined);
    const deletionJob = await geodata
      .query<{ id: string }>(
        `SELECT id FROM geodata_control_record
          WHERE kind='entityDeletionJobs' AND payload->>'entityId'=$1
          ORDER BY updated_at DESC LIMIT 1`,
        [entityId],
      )
      .catch(() => ({ rows: [] }));
    const cascadeKey = deletionJob.rows[0]
      ? `geodata-delete:${deletionJob.rows[0].id}`
      : null;
    await geodata.query('BEGIN');
    await geodata.query(
      "SELECT set_config('myota.geodata_writer','row-v1',true)",
    );
    await geodata.query(
      `DELETE FROM outbox_event WHERE aggregate_type='entity_deletion_job'
         AND aggregate_id IN (SELECT id FROM geodata_control_record
           WHERE kind='entityDeletionJobs' AND payload->>'entityId'=$1)`,
      [entityId],
    );
    await geodata.query(
      `DELETE FROM geodata_control_record
        WHERE kind='entityDeletionJobs' AND payload->>'entityId'=$1`,
      [entityId],
    );
    await geodata.query(
      `DELETE FROM geodata_audit_event WHERE aggregate_type='entity' AND aggregate_id=$1`,
      [entityId],
    );
    await geodata.query('DELETE FROM geodata_entity WHERE id=$1', [entityId]);
    await geodata.query('COMMIT');
    await activity.query('BEGIN');
    await activity.query('DELETE FROM activity_qso_correction WHERE id=$1', [
      correctionId,
    ]);
    await activity.query('DELETE FROM activity_qso WHERE id=$1', [qsoId]);
    await activity.query(
      `DELETE FROM outbox_event WHERE aggregate_type='entity' AND aggregate_id=$1`,
      [entityId],
    );
    if (cascadeKey)
      await activity.query(
        `DELETE FROM idempotency_record WHERE service='activity-service' AND key=$1`,
        [cascadeKey],
      );
    await activity.query('DELETE FROM activity_activation WHERE id=$1', [
      activationId,
    ]);
    await activity.query('DELETE FROM activity_job WHERE idempotency_key=$1', [
      `entity-delete-awards:${entityId}:${programmeSlug}`,
    ]);
    await activity.query('COMMIT');
    geodata.release();
    activity.release();
    await Promise.all([geodataPool.end(), activityPool.end()]);
  }
});
