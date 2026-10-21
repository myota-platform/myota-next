import { expect, test } from '@playwright/test';

test('creates a participant account with a permitted role grant', async ({
  page,
}) => {
  const accountRequests: Array<{ body: unknown; idempotencyKey: string }> = [];

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = method === 'GET' ? null : request.postDataJSON();

    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'admin-identity-access-token',
          refreshToken: 'admin-identity-refresh-token',
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'admin-1',
          email: 'admin@example.test',
          displayName: 'Identity Admin',
          roles: [
            {
              role: 'ACCOUNT_CREATOR',
              scopes: [
                'identity.accounts.create',
                'identity.roles.assign',
                'activity.read',
              ],
            },
          ],
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/admin/roles') {
      await route.fulfill({
        json: {
          items: [
            {
              code: 'ACTIVITY_READER',
              name: 'Activity Reader',
              scopes: ['activity.read'],
              system: true,
            },
            {
              code: 'GLOBAL_ADMIN',
              name: 'Global administrator',
              scopes: ['*'],
              system: true,
            },
          ],
          permissions: [],
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/accounts' && method === 'POST') {
      accountRequests.push({
        body,
        idempotencyKey: request.headers()['idempotency-key'] || '',
      });
      await route.fulfill({
        status: 201,
        json: {
          id: 'participant-1',
          displayName: 'Casey Operator',
          email: 'casey@example.test',
          status: 'PENDING_SETUP',
        },
      });
      return;
    }

    await route.fulfill({
      json: { items: [], page: 1, total: 0, nextPage: null },
    });
  });

  await page.goto('/identity');
  await expect(page).toHaveURL(/\/login\?redirect=\/identity$/);
  await page.getByLabel('Email').fill('admin@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/identity$/);

  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Display name').fill(' Casey Operator ');
  await page.getByLabel('Email').last().fill(' casey@example.test ');
  await page.getByLabel('Initial callsign (optional)').fill(' dl1abc ');
  await page.getByLabel(/Activity Reader/).check();
  await expect(page.getByLabel(/Global administrator/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Create account' }).last().click();

  await expect(
    page.getByText(
      'Account created with status PENDING_SETUP. No invitation was sent; invitation delivery is not available yet.',
    ),
  ).toBeVisible();
  expect(accountRequests).toHaveLength(1);
  expect(accountRequests[0].idempotencyKey).not.toBe('');
  expect(accountRequests[0].body).toEqual({
    displayName: 'Casey Operator',
    email: 'casey@example.test',
    participationType: 'OPERATOR',
    callsign: 'dl1abc',
    roles: [{ role: 'ACTIVITY_READER' }],
  });
});
