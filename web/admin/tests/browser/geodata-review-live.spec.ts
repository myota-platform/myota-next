import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, test } from '@playwright/test';
import { expectResponsiveAccessible } from '../../../a11y';

test('reviews a Geodata candidate through live Admin and Gateway services', async ({
  page,
}) => {
  const databaseUrl = process.env.GEO_DATABASE_URL;
  test.skip(!databaseUrl, 'requires the isolated Geodata parity database');
  if (!databaseUrl) return;

  const entityId = randomUUID();
  const entityName = `Live review fixture ${entityId}`;
  const note = `Verified candidate ${entityId}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const fixture = await pool.connect();
  let idempotencyKey: string | undefined;

  try {
    await fixture.query('BEGIN');
    await fixture.query(
      "SELECT set_config('myota.geodata_writer','row-v1',true)",
    );
    await fixture.query(
      `INSERT INTO geodata_entity
         (id,name,lifecycle_status,geom,entity_type_code)
       VALUES ($1,$2,'CANDIDATE',ST_SetSRID(ST_MakePoint(5.1,45.7),4326),'SOTA')`,
      [entityId, entityName],
    );
    await fixture.query('COMMIT');

    await page.goto('/geodata');
    await expect(page).toHaveURL(/\/login\?redirect=\/geodata$/);
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
    await expect(page).toHaveURL(/\/geodata$/);
    await page
      .locator('button.entity-link')
      .filter({ hasText: entityName })
      .click();
    await page.locator('select').last().selectOption('REJECTED');
    await page.getByPlaceholder('Review note / decision evidence').fill(note);

    const reviewResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === `/v1/geodata/entities/${entityId}/reviews` &&
        response.request().method() === 'POST'
      );
    });
    const saveDecisionButton = page.getByRole('button', {
      name: 'Save review decision',
    });
    await saveDecisionButton.focus();
    await expect(saveDecisionButton).toBeFocused();
    await page.keyboard.press('Enter');
    const response = await reviewResponse;
    expect(response.status(), await response.text()).toBe(200);
    const request = response.request();
    const requestBody = request.postDataJSON() as {
      status: string;
      reviewerId: string;
      note: string;
    };
    expect(requestBody).toMatchObject({ status: 'REJECTED', note });
    expect(requestBody.reviewerId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(request.headers()['if-match']).toBe('"1"');
    idempotencyKey = request.headers()['idempotency-key'];
    expect(idempotencyKey).toBeTruthy();

    await expect(page.getByText('Status changed to REJECTED.')).toBeVisible();
    await expect(page.locator('.status-pill.rejected').first()).toHaveText(
      'REJECTED',
    );

    const persisted = await fixture.query<{
      lifecycle_status: string;
      revision: string;
      reviewer_id: string;
      review_note: string;
      history_count: number;
      audit_count: number;
      outbox_count: number;
    }>(
      `SELECT e.lifecycle_status,e.revision::text,
              e.public_properties->'review'->>'reviewerId' AS reviewer_id,
              e.public_properties->'review'->>'note' AS review_note,
              jsonb_array_length(e.public_properties->'reviewHistory')::int AS history_count,
              (SELECT count(*)::int FROM geodata_audit_event a
                WHERE a.aggregate_type='entity' AND a.aggregate_id=e.id::text
                  AND a.event->>'eventType'='geodata.entity.status-changed.v1') AS audit_count,
              (SELECT count(*)::int FROM outbox_event o
                WHERE o.aggregate_type='entity' AND o.aggregate_id=e.id::text
                  AND o.event_type='geodata.entity.status-changed.v1'
                  AND o.payload->>'reviewerId'=(e.public_properties->'review'->>'reviewerId')
                  AND o.payload->>'note'=$2) AS outbox_count
         FROM geodata_entity e WHERE e.id=$1::uuid`,
      [entityId, note],
    );
    expect(persisted.rows).toEqual([
      {
        lifecycle_status: 'REJECTED',
        revision: '2',
        reviewer_id: requestBody.reviewerId,
        review_note: note,
        history_count: 1,
        audit_count: 1,
        outbox_count: 1,
      },
    ]);
    await expectResponsiveAccessible(
      page,
      'Live Admin Geodata candidate review result',
    );
  } finally {
    try {
      await fixture.query('ROLLBACK').catch(() => undefined);
      await fixture.query('BEGIN');
      await fixture.query(
        "SELECT set_config('myota.geodata_writer','row-v1',true)",
      );
      await fixture.query(
        `DELETE FROM outbox_event
          WHERE aggregate_type='entity' AND aggregate_id=$1`,
        [entityId],
      );
      await fixture.query(
        `DELETE FROM geodata_audit_event
          WHERE aggregate_type='entity' AND aggregate_id=$1`,
        [entityId],
      );
      if (idempotencyKey)
        await fixture.query(
          "DELETE FROM idempotency_record WHERE service='geodata-entity-review' AND key=$1",
          [idempotencyKey],
        );
      await fixture.query('DELETE FROM geodata_entity WHERE id=$1::uuid', [
        entityId,
      ]);
      await fixture.query('COMMIT');
    } finally {
      await fixture.query('ROLLBACK').catch(() => undefined);
      fixture.release();
      await pool.end();
    }
  }
});
