import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectResponsiveAccessible } from '../../../a11y';

test('explores a persisted Geodata entity through the live Admin map', async ({
  page,
}) => {
  const databaseUrl = process.env.GEO_DATABASE_URL;
  test.skip(!databaseUrl, 'requires the isolated Geodata parity database');
  if (!databaseUrl) return;

  const entityId = randomUUID();
  const entityName = `Live map fixture ${entityId}`;
  const requestedZooms: number[] = [];
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const fixture = await pool.connect();

  try {
    await fixture.query('BEGIN');
    await fixture.query(
      "SELECT set_config('myota.geodata_writer','row-v1',true)",
    );
    await fixture.query(
      `INSERT INTO geodata_entity
         (id,name,lifecycle_status,geom,entity_type_code,continent,country,region,city)
       VALUES
         ($1,$2,'APPROVED',ST_SetSRID(ST_MakePoint(-3.6,37.2),4326),
          'SOTA','Europe','Spain','Andalusia','Granada')`,
      [entityId, entityName],
    );
    await fixture.query('COMMIT');

    await page.route('https://tile.openstreetmap.org/**', (route) =>
      route.abort(),
    );
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/v1/geodata/map/entities')
        requestedZooms.push(Number(url.searchParams.get('zoom')));
    });
    await page.goto('/entity-map');
    await expect(page).toHaveURL(/\/login\?redirect=\/entity-map$/);
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
    await expect(page).toHaveURL(/\/entity-map$/);
    await expect(page.getByText(/entities in this view$/)).toBeVisible();
    await expect.poll(() => requestedZooms.length).toBeGreaterThan(0);
    const directory = page.locator('.entity-map-directory');
    const directorySummary = directory.locator('summary');
    await activateByKeyboard(page, directorySummary);
    const entityOption = directory.getByRole('button', { name: entityName });
    await activateByKeyboard(page, entityOption);
    await expect(entityOption).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(() => requestedZooms.some((zoom) => zoom > requestedZooms[0]!))
      .toBe(true);

    const selected = page.locator('.selected-entity');
    await expect(
      selected.getByRole('heading', { name: entityName }),
    ).toBeVisible();
    await expect(selected).toContainText('APPROVED');
    await expect(selected).toContainText('SOTA');
    await expect(selected).toContainText('Spain');
    await expect(selected).toContainText('Andalusia');
    await expect(selected).toContainText('Granada');
    await page.locator(`.leaflet-marker-icon[title="${entityName}"]`).click();
    const popup = page.locator('.myota-entity-popup-content');
    await expect(popup).toHaveCSS('color', 'rgb(20, 43, 45)');
    await expect(popup).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(popup.locator('strong')).toHaveCSS('color', 'rgb(20, 43, 45)');
    await expectResponsiveAccessible(
      page,
      'Live Admin Geodata map exploration',
    );
  } finally {
    await fixture.query('ROLLBACK').catch(() => undefined);
    await fixture.query('BEGIN');
    await fixture.query(
      "SELECT set_config('myota.geodata_writer','row-v1',true)",
    );
    await fixture.query('DELETE FROM geodata_entity WHERE id=$1', [entityId]);
    await fixture.query('COMMIT');
    fixture.release();
    await pool.end();
  }
});

async function activateByKeyboard(page: Page, control: Locator) {
  await control.focus();
  await expect(control).toBeFocused();
  await page.keyboard.press('Enter');
}
