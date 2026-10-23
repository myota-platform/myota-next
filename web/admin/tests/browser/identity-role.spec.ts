import { expect, test } from '@playwright/test';
import { expectResponsiveAccessible } from '../../../a11y';

test('creates a custom Identity role from the permission catalogue', async ({
  page,
}) => {
  const roleRequests: Array<{ body: unknown; idempotencyKey: string }> = [];
  let customRole: Record<string, any> | null = null;

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = method === 'GET' ? null : request.postDataJSON();

    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'admin-role-access-token',
          refreshToken: 'admin-role-refresh-token',
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'admin-1',
          email: 'admin@example.test',
          displayName: 'Role Admin',
          scopes: ['identity.roles.manage'],
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/admin/roles') {
      await route.fulfill({
        json: {
          items: customRole ? [customRole] : [],
          permissions: [
            {
              code: 'programme.content.manage',
              label: 'Manage programme content and translations',
            },
            { code: 'identity.roles.manage', label: 'Manage role definitions' },
          ],
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/roles' && method === 'POST') {
      roleRequests.push({
        body,
        idempotencyKey: request.headers()['idempotency-key'] || '',
      });
      customRole = {
        ...(body as Record<string, unknown>),
        system: false,
      };
      await route.fulfill({ status: 201, json: customRole });
      return;
    }

    await route.fulfill({
      json: { items: [], page: 1, total: 0, nextPage: null },
    });
  });

  await page.goto('/identity?tab=roles');
  await expect(page).toHaveURL(/\/login\?redirect=\/identity\?tab=roles$/);
  await page.getByLabel('Email').fill('admin@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/identity\?tab=roles$/);

  await page.getByRole('button', { name: 'New custom role' }).click();
  await page.getByLabel('Role code').fill('content_reviewer');
  await page.getByLabel('Display name').fill('Content Reviewer');
  await page
    .getByLabel('Description')
    .fill('Review and maintain programme content.');
  await page.getByLabel('programme.content.manage').check();
  await page.getByRole('button', { name: 'Save role' }).click();

  await expect(page.getByText('Role saved.')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Content Reviewer' }),
  ).toBeVisible();
  expect(roleRequests).toHaveLength(1);
  expect(roleRequests[0].idempotencyKey).not.toBe('');
  expect(roleRequests[0].body).toEqual({
    code: 'CONTENT_REVIEWER',
    name: 'Content Reviewer',
    description: 'Review and maintain programme content.',
    scopes: ['programme.content.manage'],
  });
  await expectResponsiveAccessible(page, 'Admin custom Identity role editor');
});
