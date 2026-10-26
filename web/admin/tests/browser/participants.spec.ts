import { expect, test } from '@playwright/test';

test('Participant Administrator can search, suspend, and reactivate participants only', async ({
  page,
}) => {
  const updates: Array<Record<string, unknown>> = [];
  let participant = {
    id: 'participant-1',
    displayName: 'Casey Operator',
    email: 'casey@example.test',
    emailVerified: true,
    status: 'ACTIVE',
    createdAt: '2026-10-26T09:00:00Z',
    updatedAt: '2026-10-26T09:00:00Z',
  };

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'participant-admin-access-token',
          refreshToken: 'participant-admin-refresh-token',
        },
      });
      return;
    }
    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'support-admin-1',
          email: 'support@example.test',
          displayName: 'Participant Admin',
          roles: [
            {
              role: 'PARTICIPANT_ADMIN',
              scopes: ['identity.participants.manage'],
            },
          ],
        },
      });
      return;
    }
    if (url.pathname === '/v1/identity/admin/participants') {
      expect(['', 'Casey']).toContain(url.searchParams.get('q'));
      await route.fulfill({
        json: {
          items: [participant],
          page: 1,
          pageSize: 50,
          total: 1,
          nextPage: null,
        },
      });
      return;
    }
    if (
      url.pathname === '/v1/identity/admin/participants/participant-1' &&
      request.method() === 'PATCH'
    ) {
      const body = request.postDataJSON() as Record<string, unknown>;
      updates.push(body);
      participant = {
        ...participant,
        ...(body.status === 'SUSPENDED' || body.status === 'ACTIVE'
          ? { status: body.status }
          : {}),
        updatedAt: '2026-10-26T10:00:00Z',
      };
      await route.fulfill({ json: participant });
      return;
    }
    if (url.pathname === '/v1/programmes') {
      await route.fulfill({
        json: { items: [], page: 1, total: 0, nextPage: null },
      });
      return;
    }
    await route.fulfill({
      json: { items: [], page: 1, total: 0, nextPage: null },
    });
  });

  await page.goto('/participants');
  await expect(page).toHaveURL(/\/login\?redirect=\/?participants$/);
  await page.getByLabel('Email').fill('support@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/participants$/);
  await page.getByLabel('Search participants').fill('Casey');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button', { name: 'Casey Operator' }).click();
  await expect(
    page.getByRole('definition').filter({ hasText: 'Verified' }),
  ).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Suspend sign-in' }).click();
  await expect(
    page.getByRole('definition').filter({ hasText: 'SUSPENDED' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Reactivate sign-in' }).click();
  await expect(
    page.getByRole('definition').filter({ hasText: 'ACTIVE' }),
  ).toBeVisible();
  expect(updates).toEqual([{ status: 'SUSPENDED' }, { status: 'ACTIVE' }]);
  await expect(
    page.getByText(
      'Administrator accounts, role grants, and role definitions are outside this workspace.',
    ),
  ).toBeVisible();
});
