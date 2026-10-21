import { expect, test } from '@playwright/test';

test('reloads the server version after an optimistic edit conflict', async ({
  page,
}) => {
  const metadataRequests: Array<{
    body: unknown;
    ifMatch: string;
    idempotencyKey: string;
  }> = [];
  const candidate = {
    id: 'entity-1',
    version: 7,
    name: 'Original summit name',
    status: 'APPROVED',
    entityType: 'SOTA',
    entityTypes: ['SOTA'],
    website: null,
    description: null,
    geometry: { type: 'Point', coordinates: [7.2, 46.1] },
    provenance: { sourceFeature: { properties: { name: 'Source summit' } } },
  };
  const serverVersion = {
    ...candidate,
    version: 8,
    name: 'Updated summit name',
  };
  let currentEntity = serverVersion;
  let conflictOnce = true;

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = method === 'GET' ? null : request.postDataJSON();

    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'admin-geodata-access-token',
          refreshToken: 'admin-geodata-refresh-token',
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'reviewer-1',
          email: 'reviewer@example.test',
          displayName: 'Geodata Reviewer',
          scopes: ['geodata.review'],
        },
      });
      return;
    }

    if (url.pathname === '/v1/programmes') {
      await route.fulfill({ json: { items: [], nextPage: null } });
      return;
    }

    if (url.pathname === '/v1/geodata/entities' && method === 'GET') {
      await route.fulfill({
        json: { items: [candidate], total: 1, page: 1, nextPage: null },
      });
      return;
    }

    if (url.pathname === '/v1/entity-types') {
      await route.fulfill({ json: { items: [] } });
      return;
    }

    if (url.pathname === '/v1/geodata/location-options') {
      await route.fulfill({ json: { continents: [] } });
      return;
    }

    if (url.pathname === '/v1/geodata/entities/entity-1/audit') {
      await route.fulfill({ json: { items: [] } });
      return;
    }

    if (url.pathname === '/v1/geodata/entities/entity-1' && method === 'GET') {
      await route.fulfill({ json: currentEntity });
      return;
    }

    if (
      url.pathname === '/v1/geodata/entities/entity-1' &&
      method === 'PATCH'
    ) {
      metadataRequests.push({
        body,
        ifMatch: request.headers()['if-match'] || '',
        idempotencyKey: request.headers()['idempotency-key'] || '',
      });
      if (conflictOnce) {
        conflictOnce = false;
        await route.fulfill({
          status: 409,
          json: { message: 'Entity changed; reload it and retry.' },
        });
      } else {
        currentEntity = { ...currentEntity, ...body, version: 9 };
        await route.fulfill({ json: currentEntity });
      }
      return;
    }

    await route.fulfill({
      json: { items: [], page: 1, total: 0, nextPage: null },
    });
  });

  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/entity-management');
  await expect(page).toHaveURL(/\/login\?redirect=\/entity-management$/);
  await page.getByLabel('Email').fill('reviewer@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/entity-management$/);

  await page
    .locator('button.entity-link')
    .filter({ hasText: 'Original summit name' })
    .click();
  await page.getByLabel('Display name').fill('My stale edit');
  await page.getByPlaceholder('Explain this name change').fill('Local edit');
  await page.getByRole('button', { name: 'Save details' }).click();

  const editor = page.getByRole('dialog', { name: 'Original summit name' });
  await expect(editor.getByRole('alert')).toContainText(
    'Entity changed; reload it and retry.',
  );
  await editor.getByRole('button', { name: 'Reload selected entity' }).click();

  await expect(page.getByLabel('Display name')).toHaveValue(
    'Updated summit name',
  );
  await expect(page.locator('.error-card')).toHaveCount(0);
  await page.getByLabel('Display name').fill('Verified summit name');
  await page
    .getByPlaceholder('Explain this name change')
    .fill('Checked the source map.');
  await page.getByRole('button', { name: 'Save details' }).click();
  await expect(page.getByText('Entity details saved.')).toBeVisible();
  await expect(page.getByLabel('Display name')).toHaveValue(
    'Verified summit name',
  );
  expect(metadataRequests).toEqual([
    {
      body: {
        name: 'My stale edit',
        website: null,
        description: null,
        note: 'Local edit',
        editorId: 'reviewer-1',
      },
      ifMatch: '"7"',
      idempotencyKey: expect.any(String),
    },
    {
      body: {
        name: 'Verified summit name',
        website: null,
        description: null,
        note: 'Checked the source map.',
        editorId: 'reviewer-1',
      },
      ifMatch: '"8"',
      idempotencyKey: expect.any(String),
    },
  ]);
  expect(metadataRequests[0].idempotencyKey).not.toBe('');
  expect(metadataRequests[1].idempotencyKey).not.toBe('');
});
