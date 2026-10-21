import { expect, test } from '@playwright/test';

test('saves account fields without widening unchanged scoped role assignments', async ({
  page,
}) => {
  const scopedRole = {
    id: 'role-assignment-1',
    accountId: 'account-1',
    role: 'GEO_APPROVER',
    programmeSlug: 'alpine',
    jurisdiction: 'CH',
    entityType: 'SUMMIT',
    scopes: ['geodata.review'],
    createdAt: '2026-01-01T00:00:00Z',
    validTo: null,
  };
  let account = {
    id: 'account-1',
    displayName: 'Casey Operator',
    email: 'casey@example.test',
    status: 'ACTIVE',
    participationType: 'OPERATOR',
    roles: [scopedRole],
    scopes: ['identity.me', 'geodata.review'],
  };
  const updates: Array<{
    authorization: string;
    body: Record<string, unknown>;
  }> = [];

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

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
          scopes: ['identity.admin', 'identity.roles.assign'],
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/admin/accounts') {
      await route.fulfill({
        json: {
          items: url.searchParams.get('q') ? [account] : [],
          page: 1,
          total: url.searchParams.get('q') ? 1 : 0,
          nextPage: null,
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/admin/roles') {
      await route.fulfill({
        json: {
          items: [
            {
              code: 'GEO_APPROVER',
              name: 'Geodata approver',
              scopes: ['geodata.review'],
              system: true,
            },
          ],
          permissions: [],
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/admin/security-events') {
      await route.fulfill({
        json: { items: [], page: 1, total: 0, nextPage: null },
      });
      return;
    }

    if (
      url.pathname === '/v1/identity/accounts/account-1' &&
      method === 'PATCH'
    ) {
      updates.push({
        authorization: request.headers().authorization || '',
        body: request.postDataJSON() as Record<string, unknown>,
      });
      account = {
        ...account,
        ...(updates.at(-1)?.body as Partial<typeof account>),
      };
      await route.fulfill({ json: account });
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

  await page.getByLabel('Search users').fill('Casey');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: /Casey Operator/ }).click();
  await expect(
    page.getByText('GEO_APPROVER · alpine · CH · SUMMIT'),
  ).toBeVisible();

  await page.getByLabel('Display name').fill('Casey Radio Operator');
  await page.getByLabel('Email').fill('casey.radio@example.test');
  await page.getByRole('button', { name: 'Save user' }).click();
  await expect(
    page.getByText(
      'User saved. Existing scoped role assignments have been preserved.',
    ),
  ).toBeVisible();

  expect(updates).toEqual([
    {
      authorization: 'Bearer admin-identity-access-token',
      body: {
        displayName: 'Casey Radio Operator',
        email: 'casey.radio@example.test',
        status: 'ACTIVE',
      },
    },
  ]);
  expect(account.roles).toEqual([scopedRole]);
});
