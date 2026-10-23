import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, test } from '@playwright/test';

test('reloads a live entity after a stale metadata edit and saves the new version', async ({
  page,
}) => {
  const databaseUrl = process.env.GEO_DATABASE_URL;
  test.skip(!databaseUrl, 'requires the isolated Geodata parity database');
  if (!databaseUrl) return;

  const entityId = randomUUID();
  const entityName = `Live conflict fixture ${entityId}`;
  const concurrentName = `Concurrent entity name ${entityId}`;
  const staleName = `Stale edit ${entityId}`;
  const savedName = `Verified edit ${entityId}`;
  const fixture = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await fixture.connect();
  const idempotencyKeys: string[] = [];
  const metadataRequests: Array<{
    status: number;
    ifMatch: string;
    key: string;
  }> = [];

  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('myota.geodata_writer','row-v1',true)",
    );
    await client.query(
      `INSERT INTO geodata_entity
         (id,name,lifecycle_status,geom,entity_type_code)
       VALUES ($1,$2,'APPROVED',ST_SetSRID(ST_MakePoint(5.1,45.7),4326),'SOTA')`,
      [entityId, entityName],
    );
    await client.query('COMMIT');

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
    const displayName = editor.getByLabel('Display name');
    await expect(displayName).toHaveValue(entityName);

    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('myota.geodata_writer','row-v1',true)",
    );
    await client.query('UPDATE geodata_entity SET name=$2 WHERE id=$1', [
      entityId,
      concurrentName,
    ]);
    await client.query('COMMIT');

    await displayName.fill(staleName);
    await editor
      .getByPlaceholder('Explain this name change')
      .fill('Edit based on the older entity version.');
    const staleResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/v1/geodata/entities/${entityId}` &&
        response.request().method() === 'PATCH',
    );
    await editor.getByRole('button', { name: 'Save details' }).click();
    const staleResponse = await staleResponsePromise;
    metadataRequests.push({
      status: staleResponse.status(),
      ifMatch: staleResponse.request().headers()['if-match'] ?? '',
      key: staleResponse.request().headers()['idempotency-key'] ?? '',
    });
    if (metadataRequests[0]?.key) idempotencyKeys.push(metadataRequests[0].key);
    expect(staleResponse.status()).toBe(409);
    expect(metadataRequests[0]?.ifMatch).toBe('"1"');
    await expect(
      page.locator('#workspace-content').getByRole('alert').first(),
    ).toContainText('entity version is stale');

    const confirmations: string[] = [];
    page.on('dialog', async (dialog) => {
      confirmations.push(dialog.message());
      await dialog.accept();
    });
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Reload selected entity' })
      .click();
    const refreshedEditor = page.getByRole('dialog', { name: concurrentName });
    const refreshedDisplayName = refreshedEditor.getByLabel('Display name');
    await expect(refreshedDisplayName).toHaveValue(concurrentName);
    await refreshedDisplayName.fill(savedName);
    await refreshedEditor
      .getByPlaceholder('Explain this name change')
      .fill('Checked against the current source record.');
    const savedResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/v1/geodata/entities/${entityId}` &&
        response.request().method() === 'PATCH',
    );
    await refreshedEditor.getByRole('button', { name: 'Save details' }).click();
    const savedResponse = await savedResponsePromise;
    metadataRequests.push({
      status: savedResponse.status(),
      ifMatch: savedResponse.request().headers()['if-match'] ?? '',
      key: savedResponse.request().headers()['idempotency-key'] ?? '',
    });
    if (metadataRequests[1]?.key) idempotencyKeys.push(metadataRequests[1].key);
    expect(savedResponse.status(), await savedResponse.text()).toBe(200);
    await expect(
      page.getByRole('dialog').getByText('Entity details saved.'),
    ).toBeVisible();

    expect(
      metadataRequests.map(({ status, ifMatch }) => ({ status, ifMatch })),
    ).toEqual([
      { status: 409, ifMatch: '"1"' },
      { status: 200, ifMatch: '"2"' },
    ]);
    expect(metadataRequests[0]?.key).not.toBe(metadataRequests[1]?.key);
    expect(confirmations).toEqual([
      'Reload the selected entity from the server? Unsaved edits will be discarded.',
    ]);

    const persisted = await client.query<{
      name: string;
      revision: string;
    }>('SELECT name,revision::text FROM geodata_entity WHERE id=$1', [
      entityId,
    ]);
    expect(persisted.rows[0]).toEqual({ name: savedName, revision: '3' });
    const audit = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM geodata_audit_event
        WHERE aggregate_type='entity' AND aggregate_id=$1
          AND event->>'eventType'='geodata.entity.name-changed.v1'`,
      [entityId],
    );
    expect(audit.rows[0]?.count).toBe('1');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('myota.geodata_writer','row-v1',true)",
    );
    await client.query(
      `DELETE FROM outbox_event
        WHERE aggregate_type='entity' AND aggregate_id=$1`,
      [entityId],
    );
    await client.query(
      `DELETE FROM geodata_audit_event
        WHERE aggregate_type='entity' AND aggregate_id=$1`,
      [entityId],
    );
    await client.query(
      `DELETE FROM idempotency_record
        WHERE service='geodata-entity-metadata' AND key=ANY($1::text[])`,
      [idempotencyKeys],
    );
    await client.query('DELETE FROM geodata_entity WHERE id=$1', [entityId]);
    await client.query('COMMIT');
    client.release();
    await fixture.end();
  }
});
