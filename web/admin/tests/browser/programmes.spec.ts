import { expect, test } from '@playwright/test';

test('creates a programme with policy and shared category settings', async ({
  page,
}) => {
  const loginPayloads: unknown[] = [];
  const createRequests: Array<{ body: any; idempotencyKey: string }> = [];
  const editRequests: Array<{ body: any; idempotencyKey: string }> = [];
  const archiveRequests: Array<{ body: any; idempotencyKey: string }> = [];
  const categories = [
    {
      code: 'SOTA',
      label: 'Summits',
      active: true,
      geometryTypes: ['POINT'],
    },
  ];
  let createdProgramme: any = null;
  let failFirstCreate = true;
  let failFirstEdit = true;
  let failFirstArchive = true;

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
      if (failFirstCreate) {
        failFirstCreate = false;
        await route.fulfill({
          status: 503,
          json: { message: 'temporary programme save response failure' },
        });
        return;
      }
      await route.fulfill({ status: 201, json: createdProgramme });
      return;
    }

    if (url.pathname === '/v1/programmes/summit-radio' && method === 'GET') {
      await route.fulfill({ json: createdProgramme });
      return;
    }

    if (url.pathname === '/v1/programmes/summit-radio' && method === 'PATCH') {
      const requestRecord = {
        body,
        idempotencyKey: request.headers()['idempotency-key'] || '',
      };
      if (body?.status === 'ARCHIVED') {
        archiveRequests.push(requestRecord);
        createdProgramme = { ...createdProgramme, status: 'ARCHIVED' };
        if (failFirstArchive) {
          failFirstArchive = false;
          await route.fulfill({
            status: 503,
            json: { message: 'temporary programme archive response failure' },
          });
          return;
        }
        await route.fulfill({ json: createdProgramme });
        return;
      }

      editRequests.push(requestRecord);
      createdProgramme = { ...createdProgramme, ...body };
      if (failFirstEdit) {
        failFirstEdit = false;
        await route.fulfill({
          status: 503,
          json: { message: 'temporary programme edit response failure' },
        });
        return;
      }
      await route.fulfill({ json: createdProgramme });
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
  const fillProgramme = async () => {
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
    await page.getByLabel('Enable programme entity IDs').check();
    await page.getByLabel('Programme ID prefix').fill('PJE');
    await page.getByLabel('Qualifier source').selectOption('LOCATION');
    await page.getByLabel('Location field').selectOption('provinceCode');
    await page.getByLabel('Serial number width').selectOption('5');
    await page
      .getByLabel('Assignment policy')
      .selectOption('QUALIFIER_SEQUENCE');
    await page.getByLabel('Assign shared category').selectOption('SOTA');
  };

  await fillProgramme();
  await page.getByRole('button', { name: 'Save programme' }).click();
  await expect(
    page.getByText('temporary programme save response failure'),
  ).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/\/programmes$/);
  await fillProgramme();
  await page.getByRole('button', { name: 'Save programme' }).click();

  await expect(page.getByText('Programme saved.')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Edit Summit Radio' }),
  ).toBeVisible();
  expect(loginPayloads).toEqual([
    { email: 'admin@example.test', password: 'test-password' },
  ]);
  expect(createRequests).toHaveLength(2);
  expect(createRequests[0].idempotencyKey).not.toBe('');
  expect(createRequests[1].idempotencyKey).toBe(
    createRequests[0].idempotencyKey,
  );
  expect(createRequests[1].body).toEqual(createRequests[0].body);
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
    entityNumbering: {
      identifier: 'PJE',
      qualifierMode: 'LOCATION',
      qualifierField: 'provinceCode',
      serialWidth: 5,
      assignmentMode: 'QUALIFIER_SEQUENCE',
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

  await page
    .getByLabel('Description')
    .fill('Update the summit guidance and qualification examples.');
  await page.getByRole('button', { name: 'Save programme' }).click();
  await expect(
    page.getByText('temporary programme edit response failure'),
  ).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/\/programmes$/);
  await page.getByRole('button').filter({ hasText: 'summit-radio' }).click();
  await expect(
    page.getByRole('heading', { name: 'Edit Summit Radio' }),
  ).toBeVisible();
  await page
    .getByLabel('Description')
    .fill('Update the summit guidance and qualification examples.');
  await page.getByRole('button', { name: 'Save programme' }).click();
  await expect(page.getByText('Programme saved.')).toBeVisible();

  expect(editRequests).toHaveLength(2);
  expect(editRequests[0].idempotencyKey).not.toBe('');
  expect(editRequests[1]).toEqual(editRequests[0]);

  const confirmations: string[] = [];
  page.on('dialog', async (dialog) => {
    confirmations.push(dialog.message());
    await dialog.accept();
  });
  await page.getByRole('button', { name: 'Archive programme' }).click();
  await expect(
    page.getByText('temporary programme archive response failure'),
  ).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/\/programmes$/);
  await page.getByRole('button').filter({ hasText: 'Summit Radio' }).click();
  await expect(
    page.getByRole('heading', { name: 'Edit Summit Radio' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Archive programme' }).click();
  await expect(page.getByText('Programme archived.')).toBeVisible();

  await expect(archiveRequests).toHaveLength(2);
  expect(archiveRequests[0]).toEqual({
    body: { status: 'ARCHIVED' },
    idempotencyKey: expect.any(String),
  });
  expect(archiveRequests[1]).toEqual(archiveRequests[0]);
  expect(confirmations).toEqual([
    'Archive summit-radio?',
    'Archive summit-radio?',
  ]);
  await expect(
    page.getByRole('button').filter({ hasText: 'ARCHIVED' }),
  ).toBeVisible();
});
