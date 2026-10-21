import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('exports an account and confirms deactivation with anonymization', async ({
  page,
}) => {
  let account: Record<string, unknown> = {
    id: 'account-1',
    displayName: 'Casey Operator',
    email: 'casey@example.test',
    status: 'ACTIVE',
    participationType: 'OPERATOR',
    roles: [],
    scopes: ['identity.me'],
  };
  const exportData = {
    account,
    roles: [],
    callsignEvidence: [],
    securityEvents: [],
  };
  let exportAuthorization = '';
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
          scopes: ['identity.admin'],
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/admin/accounts') {
      const matching = url.searchParams.get('q') && account.status === 'ACTIVE';
      await route.fulfill({
        json: {
          items: matching ? [account] : [],
          page: 1,
          total: matching ? 1 : 0,
          nextPage: null,
        },
      });
      return;
    }

    if (
      url.pathname === '/v1/identity/admin/roles' ||
      url.pathname === '/v1/identity/admin/security-events'
    ) {
      await route.fulfill({
        json: { items: [], page: 1, total: 0, nextPage: null },
      });
      return;
    }

    if (url.pathname === '/v1/identity/accounts/account-1/export') {
      exportAuthorization = request.headers().authorization || '';
      await route.fulfill({ json: exportData });
      return;
    }

    if (
      url.pathname === '/v1/identity/accounts/account-1' &&
      method === 'PATCH'
    ) {
      const body = request.postDataJSON() as Record<string, unknown>;
      updates.push({
        authorization: request.headers().authorization || '',
        body,
      });
      account = {
        ...account,
        displayName: 'Deactivated account',
        email: null,
        status: body.status,
      };
      await route.fulfill({ json: account });
      return;
    }

    await route.fulfill({
      json: { items: [], page: 1, total: 0, nextPage: null },
    });
  });

  let confirmationText = '';
  page.on('dialog', async (dialog) => {
    confirmationText = dialog.message();
    await dialog.accept();
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

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export account' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('myota-account-account-1.json');
  expect(JSON.parse(await readFile((await download.path())!, 'utf8'))).toEqual(
    exportData,
  );
  expect(exportAuthorization).toBe('Bearer admin-identity-access-token');

  await page.getByRole('button', { name: 'Deactivate and anonymize' }).click();
  await expect(
    page.getByText('Account deactivated and anonymized.'),
  ).toBeVisible();
  await expect(page.getByText('No users match this search.')).toBeVisible();
  expect(confirmationText).toBe('Deactivate and anonymize Casey Operator?');
  expect(updates).toEqual([
    {
      authorization: 'Bearer admin-identity-access-token',
      body: { status: 'DEACTIVATED', anonymize: true },
    },
  ]);
});
