import { expect, test } from '@playwright/test';

test('saves manual location metadata and queues a provider refresh', async ({
  page,
}) => {
  const locationUpdates: Array<{
    body: Record<string, unknown>;
    ifMatch: string;
    idempotencyKey: string;
  }> = [];
  const enrichmentRequests: Array<{
    body: unknown;
    ifMatch: string;
    idempotencyKey: string;
  }> = [];
  const entity: Record<string, any> = {
    id: 'entity-location-1',
    version: 3,
    name: 'Location test summit',
    status: 'APPROVED',
    entityType: 'SOTA',
    entityTypes: ['SOTA'],
    location: {},
    geometry: { type: 'Point', coordinates: [5.1, 45.7] },
    provenance: {
      sourceFeature: { properties: { name: 'Location test summit' } },
    },
  };

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'admin-location-access-token',
          refreshToken: 'admin-location-refresh-token',
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'location-admin-1',
          email: 'location-admin@example.test',
          displayName: 'Location Admin',
          role: 'GLOBAL_ADMIN',
          scopes: ['geodata.review', 'geodata.location.manage'],
        },
      });
      return;
    }

    if (url.pathname === '/v1/programmes') {
      await route.fulfill({ json: { items: [], nextPage: null } });
      return;
    }

    if (url.pathname === '/v1/geodata/entities' && method === 'GET') {
      await route.fulfill({ json: { items: [entity], total: 1, page: 1 } });
      return;
    }

    if (url.pathname === '/v1/entity-types') {
      await route.fulfill({ json: { items: [] } });
      return;
    }

    if (url.pathname === '/v1/geodata/location-options') {
      await route.fulfill({
        json: {
          continents: [
            {
              name: 'Europe',
              code: 'EU',
              countries: [
                {
                  name: 'France',
                  code: 'FR',
                  subdivisions: [{ name: 'Auvergne-Rhone-Alpes', code: 'ARA' }],
                },
              ],
            },
          ],
        },
      });
      return;
    }

    if (
      url.pathname === '/v1/geodata/entities/entity-location-1/audit' ||
      (url.pathname === '/v1/geodata/entities/entity-location-1' &&
        method === 'GET')
    ) {
      await route.fulfill({
        json: url.pathname.endsWith('/audit') ? { items: [] } : entity,
      });
      return;
    }

    if (
      url.pathname === '/v1/geodata/entities/entity-location-1' &&
      method === 'PATCH'
    ) {
      const body = request.postDataJSON() as Record<string, unknown>;
      locationUpdates.push({
        body,
        ifMatch: request.headers()['if-match'] || '',
        idempotencyKey: request.headers()['idempotency-key'] || '',
      });
      Object.assign(entity, body, {
        version: 4,
        manualLocationFields: body.manualFields,
      });
      await route.fulfill({ json: entity });
      return;
    }

    if (
      url.pathname ===
        '/v1/geodata/entities/entity-location-1/location-enrichment-requests' &&
      method === 'POST'
    ) {
      enrichmentRequests.push({
        body: request.postDataJSON(),
        ifMatch: request.headers()['if-match'] || '',
        idempotencyKey: request.headers()['idempotency-key'] || '',
      });
      entity.locationEnrichmentStatus = 'QUEUED';
      await route.fulfill({
        status: 202,
        json: { id: 'enrichment-1', status: 'QUEUED' },
      });
      return;
    }

    await route.fulfill({
      json: { items: [], page: 1, total: 0, nextPage: null },
    });
  });

  await page.goto('/entity-management');
  await expect(page).toHaveURL(/\/login\?redirect=\/entity-management$/);
  await page.getByLabel('Email').fill('location-admin@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/entity-management$/);

  await page
    .locator('button.entity-link')
    .filter({ hasText: 'Location test summit' })
    .click();
  const editor = page.getByRole('dialog', { name: 'Location test summit' });
  await editor.getByRole('button', { name: 'Location', exact: true }).click();
  await editor.getByRole('button', { name: 'Edit location metadata' }).click();
  await editor
    .locator('input[list="location-options-continent"]')
    .fill('Europe');
  await editor.locator('input[list="location-options-country"]').fill('France');
  await editor
    .locator('.location-editor-grid label')
    .filter({ hasText: /^City/ })
    .locator('input')
    .fill('Lyon');
  await editor.getByLabel('Keep country manual').check();
  await expect(editor.getByLabel('Continent code')).toHaveValue('EU');
  await expect(editor.getByLabel('Country code')).toHaveValue('FR');
  await editor.getByRole('button', { name: 'Save location' }).click();

  await expect(
    editor.getByText('Location saved.', { exact: false }),
  ).toBeVisible();
  expect(locationUpdates).toHaveLength(1);
  expect(locationUpdates[0].ifMatch).toBe('"3"');
  expect(locationUpdates[0].idempotencyKey).not.toBe('');
  expect(locationUpdates[0].body).toMatchObject({
    editorId: 'location-admin-1',
    manualFields: ['country'],
    location: {
      continent: 'Europe',
      continentCode: 'EU',
      country: 'France',
      countryCode: 'FR',
      city: 'Lyon',
      region: null,
      subdivision: null,
    },
  });

  await editor
    .getByRole('button', { name: 'Update missing location data' })
    .click();
  await expect(
    editor.getByRole('button', { name: 'Location update queued' }),
  ).toBeDisabled();
  expect(enrichmentRequests).toEqual([
    {
      body: { editorId: 'location-admin-1' },
      ifMatch: '"4"',
      idempotencyKey: expect.any(String),
    },
  ]);
  expect(enrichmentRequests[0].idempotencyKey).not.toBe('');
});
