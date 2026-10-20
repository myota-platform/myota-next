import { expect, test } from '@playwright/test';

test('login checks the session and blocks a route outside the account scope', async ({
  page,
}) => {
  const loginPayloads: unknown[] = [];
  const authenticatedRequests: string[] = [];

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === '/v1/identity/auth/login') {
      loginPayloads.push(request.postDataJSON());
      await route.fulfill({
        json: {
          accessToken: 'browser-test-access-token',
          refreshToken: 'browser-test-refresh-token',
          account: {
            id: 'account-1',
            email: 'operator@example.test',
            displayName: 'Operator',
          },
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me') {
      authenticatedRequests.push(
        request.headers().authorization || 'missing authorization',
      );
      await route.fulfill({
        json: {
          id: 'account-1',
          email: 'operator@example.test',
          displayName: 'Operator',
          roles: [{ role: 'activity-reader', scopes: ['activity.read'] }],
        },
      });
      return;
    }

    if (url.pathname === '/v1/programmes') {
      authenticatedRequests.push(
        request.headers().authorization || 'missing authorization',
      );
      await route.fulfill({
        json: { items: [], nextPage: null },
      });
      return;
    }

    await route.fulfill({ json: { items: [], total: 0, nextPage: null } });
  });

  await page.goto('/identity');
  await expect(page).toHaveURL(/\/login\?redirect=\/identity$/);
  await page.getByLabel('Email').fill('operator@example.test');
  await page.getByLabel('Password').fill('correct-horse-battery-staple');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/access-denied$/);
  await expect(
    page.getByRole('heading', { name: /access not available/i }),
  ).toBeVisible();
  expect(loginPayloads).toEqual([
    {
      email: 'operator@example.test',
      password: 'correct-horse-battery-staple',
    },
  ]);
  expect(authenticatedRequests).toEqual([
    'Bearer browser-test-access-token',
    'Bearer browser-test-access-token',
  ]);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('myota_admin_access')))
    .toBe('browser-test-access-token');
});

test('shows the API login error without creating a session', async ({
  page,
}) => {
  await page.route('**/v1/identity/auth/login', (route) =>
    route.fulfill({
      status: 401,
      json: { message: 'Email or password is incorrect.' },
    }),
  );

  await page.goto('/login');
  await page.getByLabel('Email').fill('operator@example.test');
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('alert')).toHaveText(
    'Email or password is incorrect.',
  );
  await expect(page).toHaveURL(/\/login$/);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('myota_admin_access')))
    .toBeNull();
});
