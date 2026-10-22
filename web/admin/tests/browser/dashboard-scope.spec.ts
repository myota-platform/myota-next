import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function openDashboard(
  page: Page,
  scopes: string[],
  activationStatus = 200,
): Promise<string[]> {
  const requests: string[] = [];
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = `${request.method()} ${url.pathname}${url.search}`;

    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'dashboard-scope-access-token',
          refreshToken: 'dashboard-scope-refresh-token',
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'dashboard-user-1',
          email: 'dashboard-user@example.test',
          displayName: 'Dashboard User',
          scopes,
        },
      });
      return;
    }

    requests.push(path);
    if (url.pathname === '/v1/programmes') {
      await route.fulfill({
        json: {
          items: [{ slug: 'summits', name: 'Summits' }],
          nextPage: null,
        },
      });
      return;
    }

    if (url.pathname === '/v1/geodata/entities') {
      await route.fulfill({
        json: {
          items: [{ id: 'candidate-1', name: 'Peak Alpha' }],
          total: 2,
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/admin/accounts') {
      await route.fulfill({ json: { items: [], total: 3 } });
      return;
    }

    if (url.pathname === '/v1/identity/admin/security-events') {
      await route.fulfill({
        json: {
          items: [
            {
              id: 'event-1',
              eventType: 'identity.account.login.v1',
              occurredAt: '2026-10-22T08:00:00Z',
            },
          ],
          total: 1,
        },
      });
      return;
    }

    if (url.pathname === '/v1/activations') {
      await route.fulfill({
        status: activationStatus,
        json:
          activationStatus === 200
            ? { items: [], total: 7, page: 1, nextPage: null }
            : { message: 'Activity API unavailable.' },
      });
      return;
    }

    await route.fulfill({
      status: 403,
      json: { message: 'Unexpected request' },
    });
  });

  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login\?redirect=\/dashboard$/);
  await page.getByLabel('Email').fill('dashboard-user@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(
    page.getByRole('heading', { name: 'Start a task' }),
  ).toBeVisible();

  return requests;
}

test('limits dashboard data requests and metrics to the account scopes', async ({
  page,
}) => {
  const requests = await openDashboard(page, ['activity.read']);

  await expect(page.getByText('Activations', { exact: true })).toBeVisible();
  await expect(
    page.locator('.metric').filter({ hasText: 'Activations' }),
  ).toContainText('7');
  await expect(page.getByText('Users', { exact: true })).toHaveCount(0);
  await expect(
    page.getByText('Review candidates', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator('.metric').filter({ hasText: 'Programmes' }),
  ).toHaveCount(0);
  expect(requests).toEqual([
    'GET /v1/programmes?page=1&pageSize=100',
    'GET /v1/activations?pageSize=1',
  ]);
});

test('shows all authorized dashboard panels and refreshes cached programmes on demand', async ({
  page,
}) => {
  const requests = await openDashboard(page, [
    'programme.admin',
    'geodata.review',
    'identity.admin',
    'activity.read',
  ]);

  await expect(page.locator('.metric')).toHaveCount(4);
  await expect(
    page.locator('.metric').filter({ hasText: 'Programmes' }),
  ).toContainText('1');
  await expect(
    page.locator('.metric').filter({ hasText: 'Review candidates' }),
  ).toContainText('2');
  await expect(
    page.locator('.metric').filter({ hasText: 'Users' }),
  ).toContainText('3');
  await expect(
    page.locator('.metric').filter({ hasText: 'Activations' }),
  ).toContainText('7');
  await expect(page.getByText('Peak Alpha')).toBeVisible();
  await expect(page.getByText('identity.account.login.v1')).toBeVisible();
  expect(requests).toHaveLength(5);
  expect(requests).toEqual(
    expect.arrayContaining([
      'GET /v1/programmes?page=1&pageSize=100',
      'GET /v1/geodata/entities?status=CANDIDATE&pageSize=5',
      'GET /v1/identity/admin/accounts?pageSize=1',
      'GET /v1/identity/admin/security-events?pageSize=5',
      'GET /v1/activations?pageSize=1',
    ]),
  );

  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect.poll(() => requests.length).toBe(10);
  expect(
    requests.filter((path) => path.startsWith('GET /v1/programmes')),
  ).toHaveLength(2);
});

test('keeps the dashboard available when a permitted data source fails', async ({
  page,
}) => {
  const requests = await openDashboard(page, ['activity.read'], 503);

  await expect(page.getByRole('alert')).toContainText(
    'activity data is unavailable. Other workspaces remain available.',
  );
  await expect(page.getByText('Not available yet')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Start a task' }),
  ).toBeVisible();
  expect(requests).toEqual([
    'GET /v1/programmes?page=1&pageSize=100',
    'GET /v1/activations?pageSize=1',
  ]);
});
