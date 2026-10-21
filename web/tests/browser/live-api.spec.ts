import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

const hasApiDatabases = Boolean(
  process.env.CORE_DATABASE_URL &&
  process.env.ACTIVITY_DATABASE_URL &&
  process.env.GEO_DATABASE_URL,
);

test('records a Participant activation through live NestJS APIs', async ({
  page,
  request,
}) => {
  test.skip(!hasApiDatabases, 'requires the CI PostgreSQL databases');

  const email =
    process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL ?? 'browser-e2e-admin@example.test';
  const password =
    process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD ?? 'browser-e2e-password-7!Q';
  const login = await request.post(
    'http://127.0.0.1:8080/v1/identity/auth/login',
    { data: { email, password } },
  );
  expect(login.ok()).toBeTruthy();
  const { accessToken, account } = await login.json();
  const callsign = `DL1E${randomUUID().replaceAll('-', '').slice(0, 4)}`;
  const callsignResponse = await request.post(
    `http://127.0.0.1:8080/v1/identity/accounts/${account.id}/callsigns`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Idempotency-Key': randomUUID(),
      },
      data: { callsign },
    },
  );
  expect(callsignResponse.status()).toBe(201);
  const slug = `browser-${randomUUID()}`;
  const entityId = `browser-entity-${randomUUID()}`;
  const entityType = `E2E_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const created = await request.post('http://127.0.0.1:8080/v1/programmes', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Idempotency-Key': randomUUID(),
    },
    data: {
      slug,
      name: 'Browser integration programme',
      description: 'Served by the live NestJS APIs.',
      entityTypes: [
        {
          code: entityType,
          label: 'Integration point',
          geometryTypes: ['POINT'],
        },
      ],
      rules: {
        activationValidityDays: 7,
        minimumQsos: { activation: 1, hunter: 1 },
        publicAccessRequired: false,
        allowUnverifiedCallsign: true,
      },
    },
  });
  expect(created.status()).toBe(201);

  const failedResponses: string[] = [];
  await page.route('**/v1/geodata/entities**', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      json: {
        items: [
          {
            id: entityId,
            name: 'Browser integration point',
            entityType,
            status: 'APPROVED',
            centroid: { lat: 46.1, lon: 7.2 },
            geometry: { type: 'Point', coordinates: [7.2, 46.1] },
          },
        ],
        page: 1,
        total: 1,
        nextPage: null,
      },
    });
  });
  page.on('response', (response) => {
    if (response.url().includes('/v1/') && response.status() >= 400)
      failedResponses.push(`${response.status()} ${response.url()}`);
  });
  const contentResponse = page.waitForResponse((response) =>
    response.url().includes('/content'),
  );
  await page.goto(`http://127.0.0.1:8091/#${slug}`);
  expect((await contentResponse).ok()).toBeTruthy();

  await expect(page.locator('#programme-name')).toHaveText(
    'Browser integration programme',
  );
  await expect(page.locator('#entity-page-status')).toHaveText(
    'Page 1 · 1 entities',
  );
  await page.locator('#award-email').fill(email);
  await page.locator('#award-password').fill(password);
  await page.locator('#award-login button[type="submit"]').click();
  await expect(page.locator('#activation-start-form')).toBeVisible();
  await page.locator('#activation-entity').selectOption(entityId);
  await page.getByLabel('Operator callsign').selectOption({
    label: `${callsign} · UNVERIFIED`,
  });
  await page.getByRole('button', { name: 'Start activation' }).click();
  await expect(page.locator('#activation-status')).toHaveText(
    'Activation started.',
  );
  await page.getByLabel('Worked callsign').fill('F4E2E');
  await page.getByLabel('Band').fill('20M');
  await page.getByLabel('Mode').fill('SSB');
  await page.getByRole('button', { name: 'Record contact' }).click();
  await expect(page.locator('#activation-status')).toHaveText(
    'Contact recorded.',
  );
  page.on('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Close activation' }).click();
  await expect(page.locator('#activation-status')).toHaveText(
    'Activation closed.',
  );
  expect(failedResponses).toEqual([]);
});

test('signs into Admin through Gateway and loads its live dashboard', async ({
  page,
}) => {
  test.skip(!hasApiDatabases, 'requires the CI PostgreSQL databases');

  const email =
    process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL ?? 'browser-e2e-admin@example.test';
  const password =
    process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD ?? 'browser-e2e-password-7!Q';
  const failedResponses: string[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/v1/') && response.status() >= 400)
      failedResponses.push(`${response.status()} ${response.url()}`);
  });

  await page.goto('http://127.0.0.1:8090/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText('API connected')).toBeVisible();
  await expect(
    page.getByText('available programme configurations'),
  ).toBeVisible();
  expect(failedResponses).toEqual([]);
});
