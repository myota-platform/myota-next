import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, test } from '@playwright/test';
import { expectResponsiveAccessible } from '../../../a11y';

test('replaces entity geometry through live Admin and Geodata services', async ({
  page,
}) => {
  const databaseUrl = process.env.GEO_DATABASE_URL;
  test.skip(!databaseUrl, 'requires the isolated Geodata parity database');
  if (!databaseUrl) return;

  const entityId = randomUUID();
  const entityName = `Live geometry fixture ${entityId}`;
  const note = `Adjusted boundary ${entityId}`;
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
       VALUES ($1,$2,'APPROVED',ST_SetSRID(ST_MakePoint(5.1,45.7),4326),'SOTA')`,
      [entityId, entityName],
    );
    await fixture.query('COMMIT');

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
    const editor = page.getByRole('dialog', { name: entityName });
    await editor.getByRole('button', { name: 'Geometry', exact: true }).click();
    await editor.getByText('Advanced GeoJSON / geometry type').click();
    await editor
      .getByPlaceholder('GeoJSON geometry')
      .fill(JSON.stringify({ type: 'Point', coordinates: [5.2, 45.8] }));
    await editor.getByLabel('Geometry change note').fill(note);

    const [response] = await Promise.all([
      page.waitForResponse((candidate) => {
        const url = new URL(candidate.url());
        return (
          url.pathname === `/v1/geodata/entities/${entityId}/geometry` &&
          candidate.request().method() === 'PUT'
        );
      }),
      editor.getByRole('button', { name: 'Save geometry' }).click(),
    ]);
    expect(response.status(), await response.text()).toBe(200);
    const request = response.request();
    expect(request.headers()['if-match']).toBe('"1"');
    idempotencyKey = request.headers()['idempotency-key'];
    expect(idempotencyKey).toBeTruthy();
    expect(request.postDataJSON()).toMatchObject({
      geometry: { type: 'Point', coordinates: [5.2, 45.8] },
      note,
      editorId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });
    await expect(
      editor.getByText('Geometry saved.', { exact: false }),
    ).toBeVisible();
    await expectResponsiveAccessible(page, 'Live Admin entity geometry edit');

    const persisted = await fixture.query<{
      longitude: number;
      latitude: number;
      revision: string;
      history_count: number;
      audit_count: number;
      outbox_count: number;
    }>(
      `SELECT ST_X(geom) AS longitude,ST_Y(geom) AS latitude,
              revision::text,
              jsonb_array_length(public_properties->'geometryHistory')::int AS history_count,
              (SELECT count(*)::int FROM geodata_audit_event a
                WHERE a.aggregate_type='entity' AND a.aggregate_id=e.id::text
                  AND a.event->>'eventType'='geodata.entity.geometry-updated.v1') AS audit_count,
              (SELECT count(*)::int FROM outbox_event o
                WHERE o.aggregate_type='entity' AND o.aggregate_id=e.id::text
                  AND o.event_type='geodata.entity.geometry-updated.v1'
                  AND o.payload->>'note'=$2) AS outbox_count
         FROM geodata_entity e WHERE e.id=$1::uuid`,
      [entityId, note],
    );
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]).toMatchObject({
      longitude: 5.2,
      latitude: 45.8,
      history_count: 1,
      audit_count: 1,
      outbox_count: 1,
    });
    expect(Number(persisted.rows[0]?.revision)).toBeGreaterThan(1);
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
          "DELETE FROM idempotency_record WHERE service='geodata-entity-geometry' AND key=$1",
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
