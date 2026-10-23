import { expect, test } from '@playwright/test';

test('creates an inactive shared category with selected geometry types', async ({
  page,
}) => {
  const categoryRequests: unknown[] = [];
  let categories: Array<Record<string, unknown>> = [];

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'admin-master-data-access-token',
          refreshToken: 'admin-master-data-refresh-token',
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'programme-admin-1',
          email: 'programme-admin@example.test',
          displayName: 'Programme Admin',
          scopes: ['programme.admin'],
        },
      });
      return;
    }

    if (url.pathname === '/v1/programmes') {
      await route.fulfill({ json: { items: [], nextPage: null } });
      return;
    }

    if (url.pathname === '/v1/entity-types' && method === 'GET') {
      await route.fulfill({ json: { items: categories } });
      return;
    }

    if (url.pathname === '/v1/entity-types' && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      categoryRequests.push({
        body,
        idempotencyKey: request.headers()['idempotency-key'] || '',
      });
      categories = [
        {
          code: body.code,
          label: body.label,
          description: body.description,
          active: body.active,
          geometryTypes: body.geometryTypes,
          assignedProgrammes: [],
        },
      ];
      await route.fulfill({ status: 201, json: categories[0] });
      return;
    }

    await route.fulfill({ json: { items: [], nextPage: null } });
  });

  await page.goto('/master-data');
  await expect(page).toHaveURL(/\/login\?redirect=\/master-data$/);
  await page.getByLabel('Email').fill('programme-admin@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/master-data$/);

  await page.getByRole('button', { name: 'New category' }).click();
  await page.getByLabel('Category code').fill('HIKING');
  await page.getByLabel('Display name').fill('Hiking Areas');
  await page.getByLabel('Point').check();
  await page.getByLabel('MultiPolygon').uncheck();
  await page.getByLabel('Availability').selectOption('false');
  await page.getByLabel('Description').fill('Areas used by hiking awards.');
  await page.getByRole('button', { name: 'Save category' }).click();

  await expect(page.getByText('Category saved.')).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Hiking Areas/ }),
  ).toContainText('Inactive');
  expect(categoryRequests).toHaveLength(1);
  expect(categoryRequests[0]).toMatchObject({
    body: {
      code: 'HIKING',
      originalCode: 'HIKING',
      label: 'Hiking Areas',
      description: 'Areas used by hiking awards.',
      active: false,
      geometryTypes: ['POINT'],
    },
  });
  expect(
    (categoryRequests[0] as { idempotencyKey: string }).idempotencyKey,
  ).toMatch(/^[0-9a-f-]{36}$/i);
});
