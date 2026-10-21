import { expect, test } from '@playwright/test';

test('creates a programme with policy and shared category settings', async ({
  page,
}) => {
  const loginPayloads: unknown[] = [];
  const createRequests: Array<{ body: any; idempotencyKey: string }> = [];
  const categories = [
    {
      code: 'SOTA',
      label: 'Summits',
      active: true,
      geometryTypes: ['POINT'],
    },
  ];
  let createdProgramme: any = null;

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = method === 'GET' ? null : request.postDataJSON();

    if (url.pathname === '/v1/identity/auth/login') {
      loginPayloads.push(body);
      await route.fulfill({
        json: {
          accessToken: 'admin-programme-access-token',
          refreshToken: 'admin-programme-refresh-token',
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'admin-1',
          email: 'admin@example.test',
          displayName: 'Programme Admin',
          roles: [{ role: 'programme-admin', scopes: ['programme.admin'] }],
        },
      });
      return;
    }

    if (url.pathname === '/v1/programmes' && method === 'GET') {
      await route.fulfill({
        json: {
          items: createdProgramme ? [createdProgramme] : [],
          nextPage: null,
        },
      });
      return;
    }

    if (url.pathname === '/v1/programmes' && method === 'POST') {
      createRequests.push({
        body,
        idempotencyKey: request.headers()['idempotency-key'] || '',
      });
      createdProgramme = {
        ...body,
        status: 'ACTIVE',
        policyVersion: 1,
      };
      await route.fulfill({ status: 201, json: createdProgramme });
      return;
    }

    if (url.pathname === '/v1/entity-types') {
      await route.fulfill({ json: { items: categories } });
      return;
    }

    await route.fulfill({ json: { items: [], nextPage: null, total: 0 } });
  });

  await page.goto('/programmes');
  await expect(page).toHaveURL(/\/login\?redirect=\/programmes$/);
  await page.getByLabel('Email').fill('admin@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/programmes$/);
  await page.getByLabel('Programme identifier').fill('summit-radio');
  await page.getByLabel('Programme name').fill('Summit Radio');
  await page
    .getByLabel('Description')
    .fill('Activate summits and make contacts.');
  await page.getByLabel('Minimum activation QSOs').fill('6');
  await page.getByLabel('Minimum hunter QSOs').fill('2');
  await page.getByLabel('Activation validity').selectOption('finite');
  await page.getByLabel('Validity days').fill('30');
  await page.getByLabel('Require public access').check();
  await page.getByRole('combobox').nth(1).selectOption('SOTA');
  await page.getByRole('button', { name: 'Save programme' }).click();

  await expect(page.getByText('Programme saved.')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Edit Summit Radio' }),
  ).toBeVisible();
  expect(loginPayloads).toEqual([
    { email: 'admin@example.test', password: 'test-password' },
  ]);
  expect(createRequests).toHaveLength(1);
  expect(createRequests[0].idempotencyKey).not.toBe('');
  expect(createRequests[0].body).toMatchObject({
    slug: 'summit-radio',
    name: 'Summit Radio',
    description: 'Activate summits and make contacts.',
    rules: {
      minimumQsos: { activation: 6, hunter: 2 },
      activationValidityDays: 30,
      publicAccessRequired: true,
      excludeOverlappingProgrammes: false,
    },
    entityTypes: [
      {
        code: 'SOTA',
        label: 'Summits',
        active: true,
        geometryTypes: ['POINT'],
      },
    ],
  });
});
