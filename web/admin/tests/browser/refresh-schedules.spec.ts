import { expect, test } from '@playwright/test';

test('creates a refresh schedule and queues a complete GeoJSON snapshot', async ({
  page,
}) => {
  const createRequests: unknown[] = [];
  const runRequests: unknown[] = [];
  const schedule = {
    id: 'schedule-1',
    programmeSlug: 'alpine',
    entityTypes: ['SOTA'],
    adapter: 'MANUAL',
    source: { name: 'Alpine snapshot' },
    intervalSeconds: 86400,
    disappearancePolicy: 'REVIEW_REQUIRED',
    enabled: true,
  };

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'admin-refresh-access-token',
          refreshToken: 'admin-refresh-refresh-token',
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'geodata-importer-1',
          email: 'geodata-importer@example.test',
          displayName: 'Geodata Importer',
          scopes: ['geodata.import'],
        },
      });
      return;
    }

    if (url.pathname === '/v1/programmes') {
      await route.fulfill({
        json: {
          items: [{ slug: 'alpine', name: 'Alpine Summits' }],
          nextPage: null,
        },
      });
      return;
    }

    if (url.pathname === '/v1/entity-types') {
      await route.fulfill({
        json: {
          items: [
            {
              code: 'SOTA',
              label: 'Summits on the Air',
              active: true,
              geometryTypes: ['POINT'],
            },
          ],
        },
      });
      return;
    }

    if (url.pathname === '/v1/geodata/refresh-schedules' && method === 'GET') {
      await route.fulfill({
        json: {
          items: createRequests.length ? [schedule] : [],
          page: 1,
          pageSize: 100,
          total: createRequests.length,
          nextPage: null,
        },
      });
      return;
    }

    if (url.pathname === '/v1/geodata/refresh-schedules' && method === 'POST') {
      createRequests.push(request.postDataJSON());
      await route.fulfill({ status: 201, json: schedule });
      return;
    }

    if (
      url.pathname === '/v1/geodata/refresh-schedules/schedule-1/run' &&
      method === 'POST'
    ) {
      runRequests.push(request.postDataJSON());
      await route.fulfill({ status: 202, json: { id: 'import-run-1' } });
      return;
    }

    await route.fulfill({
      json: { items: [], page: 1, total: 0, nextPage: null },
    });
  });

  await page.goto('/refresh-schedules');
  await expect(page).toHaveURL(/\/login\?redirect=\/refresh-schedules$/);
  await page.getByLabel('Email').fill('geodata-importer@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/refresh-schedules$/);

  await page.getByLabel('Programme').selectOption('alpine');
  await page.getByLabel('Summits on the Air').check();
  await page
    .getByLabel('Source settings (JSON object)')
    .fill('{"name":"Alpine snapshot"}');
  await page.getByRole('button', { name: 'Create schedule' }).click();
  await expect(page.getByText('Refresh schedule created.')).toBeVisible();

  await page.getByLabel('Manual complete snapshot (GeoJSON)').setInputFiles({
    name: 'summits.geojson',
    mimeType: 'application/geo+json',
    buffer: Buffer.from(
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { name: 'Test summit' },
            geometry: { type: 'Point', coordinates: [7.2, 46.1] },
          },
        ],
      }),
    ),
  });
  await page.getByRole('button', { name: 'Run with snapshot' }).click();

  await expect(page.locator('.success-text[role="status"]')).toContainText(
    'Import import-run-1.',
  );
  expect(createRequests).toEqual([
    {
      programmeSlug: 'alpine',
      adapter: 'MANUAL',
      entityTypes: ['SOTA'],
      source: { name: 'Alpine snapshot' },
      intervalSeconds: 86400,
      disappearancePolicy: 'REVIEW_REQUIRED',
    },
  ]);
  expect(runRequests).toEqual([
    {
      features: [
        {
          type: 'Feature',
          properties: { name: 'Test summit' },
          geometry: { type: 'Point', coordinates: [7.2, 46.1] },
        },
      ],
    },
  ]);
});
