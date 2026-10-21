import { expect, test } from '@playwright/test';

test('queues pasted GeoJSON and promotes its preprocessed candidate', async ({
  page,
}) => {
  const importRequests: Array<{ body: Record<string, any>; key: string }> = [];
  const run = {
    id: 'import-1',
    filename: 'summits.geojson',
    status: 'PREPROCESSED',
    adapter: 'MANUAL',
    format: 'GEOJSON',
    entityTypes: ['SOTA'],
    candidateCount: 1,
    pendingCount: 1,
  };
  const feature = {
    id: 'candidate-1',
    ordinal: 1,
    name: 'Example summit',
    validationStatus: 'PENDING',
    geometry: { type: 'Point', coordinates: [7.2, 46.1] },
  };
  let candidatePending = true;
  const promotionRequests: Array<{ body: unknown; key: string }> = [];

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'admin-geodata-import-access-token',
          refreshToken: 'admin-geodata-import-refresh-token',
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
      await route.fulfill({ json: { items: [], nextPage: null } });
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

    if (url.pathname === '/v1/geodata/imports' && method === 'GET') {
      const items = importRequests.length ? [run] : [];
      await route.fulfill({
        json: {
          items,
          page: 1,
          pageSize: 10,
          total: items.length,
          nextPage: null,
        },
      });
      return;
    }

    if (url.pathname === '/v1/geodata/imports' && method === 'POST') {
      importRequests.push({
        body: request.postDataJSON() as Record<string, any>,
        key: request.headers()['idempotency-key'] || '',
      });
      await route.fulfill({ status: 201, json: run });
      return;
    }

    if (url.pathname === '/v1/geodata/imports/import-1/candidates') {
      await route.fulfill({
        json: {
          items: candidatePending ? [feature] : [],
          total: candidatePending ? 1 : 0,
          nextPage: null,
        },
      });
      return;
    }

    if (
      url.pathname === '/v1/geodata/imports/import-1/process' &&
      method === 'POST'
    ) {
      promotionRequests.push({
        body: request.postDataJSON(),
        key: request.headers()['idempotency-key'] || '',
      });
      candidatePending = false;
      await route.fulfill({ status: 202, json: { id: 'promotion-queue-1' } });
      return;
    }

    if (
      url.pathname ===
      '/v1/geodata/imports/import-1/processing-queues/promotion-queue-1'
    ) {
      await route.fulfill({
        json: { id: 'promotion-queue-1', status: 'COMPLETED', result: {} },
      });
      return;
    }

    if (url.pathname === '/v1/geodata/imports/import-1') {
      await route.fulfill({
        json: { ...run, pendingCount: candidatePending ? 1 : 0 },
      });
      return;
    }

    await route.fulfill({
      json: { items: [], page: 1, total: 0, nextPage: null },
    });
  });

  await page.goto('/geodata-imports');
  await expect(page).toHaveURL(/\/login\?redirect=\/geodata-imports$/);
  await page.getByLabel('Email').fill('geodata-importer@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/geodata-imports$/);

  await page.getByLabel('Feature category').selectOption('SOTA');
  await page.getByLabel('Source label').fill('Alpine manual source');
  await page.getByLabel('Licence').fill('CC BY 4.0');
  await page.getByLabel('Attribution').fill('Local mapping group');
  await page.getByLabel('Source filename').fill('summits.geojson');
  await page.getByLabel('Paste source document').fill(
    JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { name: 'Example summit' },
          geometry: { type: 'Point', coordinates: [7.2, 46.1] },
        },
      ],
    }),
  );
  await page.getByRole('button', { name: 'Queue preprocessing' }).click();

  await expect(
    page.getByText('Dataset queued for preprocessing.'),
  ).toBeVisible();
  await expect(page.getByText('Review pre-processed records')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Example summit' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Example summit' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('PENDING');
  await dialog.getByRole('button', { name: 'Promote to candidate' }).click();
  await expect(dialog.getByRole('status')).toContainText(
    'The last pending item in this import has been processed.',
  );

  expect(importRequests).toHaveLength(1);
  expect(importRequests[0].key).toMatch(/^[0-9a-f-]{36}$/i);
  expect(importRequests[0].body).toMatchObject({
    adapter: 'MANUAL',
    format: 'GEOJSON',
    entityTypes: ['SOTA'],
    filename: 'summits.geojson',
    content: expect.stringContaining('Example summit'),
    source: {
      name: 'Alpine manual source',
      license: 'CC BY 4.0',
      attribution: 'Local mapping group',
    },
  });
  expect(promotionRequests).toHaveLength(1);
  expect(promotionRequests[0].key).toMatch(/^[0-9a-f-]{36}$/i);
  expect(promotionRequests[0].body).toEqual({
    candidateIds: ['candidate-1'],
    targetStatus: 'CANDIDATE',
    processorId: 'geodata-importer-1',
  });
});
