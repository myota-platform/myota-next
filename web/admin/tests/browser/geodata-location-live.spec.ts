import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, test } from '@playwright/test';

test('saves manual location metadata through the live Geodata API', async ({
  page,
}) => {
  const databaseUrl = process.env.GEO_DATABASE_URL;
  test.skip(!databaseUrl, 'requires the isolated Geodata parity database');
  if (!databaseUrl) return;

  const entityId = randomUUID();
  const entityName = `Live location fixture ${entityId}`;
  const catalogueEntityId = randomUUID();
  const catalogueEntityName = `Location catalogue fixture ${catalogueEntityId}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const fixture = await pool.connect();
  try {
    await fixture.query('BEGIN');
    await fixture.query(
      "SELECT set_config('myota.geodata_writer','row-v1',true)",
    );
    await fixture.query(
      `INSERT INTO geodata_entity
         (id,name,lifecycle_status,geom,entity_type_code,continent,
          continent_code,country,country_code,city)
       VALUES
         ($1,$2,'APPROVED',ST_SetSRID(ST_MakePoint(5.1,45.7),4326),'SOTA',NULL,NULL,NULL,NULL,NULL),
         ($3,$4,'APPROVED',ST_SetSRID(ST_MakePoint(2.35,48.86),4326),'SOTA',
          'Europe','EU','France','FR','Paris')`,
      [entityId, entityName, catalogueEntityId, catalogueEntityName],
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
    await editor.getByRole('button', { name: 'Location', exact: true }).click();
    await editor
      .getByRole('button', { name: 'Edit location metadata' })
      .click();
    await editor
      .locator('input[list="location-options-country"]')
      .fill('France');
    await editor.getByLabel('City', { exact: true }).fill('Lyon');
    await editor.getByLabel('Keep country manual').check();
    await editor.getByLabel('Keep city manual').check();
    const [locationResponse] = await Promise.all([
      page.waitForResponse(
        (response) => {
          const url = new URL(response.url());
          return (
            url.pathname === `/v1/geodata/entities/${entityId}` &&
            response.request().method() === 'PATCH'
          );
        },
        { timeout: 5_000 },
      ),
      editor.getByRole('button', { name: 'Save location' }).click(),
    ]);
    expect(locationResponse.status(), await locationResponse.text()).toBe(200);

    const saved = await fixture.query<{
      country: string | null;
      city: string | null;
      manual_location_fields: string[];
      revision: string;
    }>(
      `SELECT country,city,manual_location_fields,revision::text
         FROM geodata_entity WHERE id=$1`,
      [entityId],
    );
    expect(saved.rows[0]).toMatchObject({
      country: 'France',
      city: 'Lyon',
      manual_location_fields: ['city', 'country'],
      revision: '2',
    });

    const audit = await fixture.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM geodata_audit_event
        WHERE aggregate_type='entity' AND aggregate_id=$1
          AND event->>'eventType'='geodata.entity.location-updated.v1'`,
      [entityId],
    );
    expect(audit.rows[0]?.count).toBe('1');
  } finally {
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
    await fixture.query('DELETE FROM geodata_entity WHERE id=$1', [entityId]);
    await fixture.query('DELETE FROM geodata_entity WHERE id=$1', [
      catalogueEntityId,
    ]);
    await fixture.query('COMMIT');
    fixture.release();
    await pool.end();
  }
});
