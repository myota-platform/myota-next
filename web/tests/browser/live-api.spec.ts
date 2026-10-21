import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

const hasApiDatabases = Boolean(
  process.env.CORE_DATABASE_URL &&
  process.env.ACTIVITY_DATABASE_URL &&
  process.env.GEO_DATABASE_URL,
);

test('loads a real programme catalogue through Gateway and Geodata', async ({
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
  const { accessToken } = await login.json();
  const slug = `browser-${randomUUID()}`;
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
          code: `E2E_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
          label: 'Integration point',
          geometryTypes: ['POINT'],
        },
      ],
      rules: {
        activationValidityDays: 7,
        minimumQsos: { activation: 1, hunter: 1 },
        publicAccessRequired: false,
      },
    },
  });
  expect(created.status()).toBe(201);

  const failedResponses: string[] = [];
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
    'Page 1 · 0 entities',
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
