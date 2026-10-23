import { expect, test } from '@playwright/test';

test('views activation QSOs and queues a statistics rebuild', async ({
  page,
}) => {
  const rebuildRequests: Array<{ body: unknown; idempotencyKey: string }> = [];
  const activation = {
    id: 'activation-1',
    programmeSlug: 'summits',
    entityId: 'summit-1',
    operatorId: 'operator-1',
    operatorCallsign: 'DL1ABC',
    status: 'CLOSED',
    qsoCount: 1,
    startedAt: '2026-10-20T08:00:00Z',
    endedAt: '2026-10-20T09:00:00Z',
    qsos: [
      {
        id: 'qso-1',
        workedCallsign: 'F4XYZ',
        timestamp: '2026-10-20T08:30:00Z',
        band: '20m',
        mode: 'SSB',
        status: 'VALID',
      },
    ],
  };
  let rebuildJob = {
    jobId: 'rebuild-1',
    kind: 'STATISTICS_REBUILD',
    status: 'QUEUED',
    attempts: 0,
  };

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'admin-activity-access-token',
          refreshToken: 'admin-activity-refresh-token',
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'activity-admin-1',
          email: 'activity-admin@example.test',
          displayName: 'Activity Admin',
          scopes: ['activity.read', 'activity.admin'],
        },
      });
      return;
    }

    if (url.pathname === '/v1/programmes') {
      await route.fulfill({ json: { items: [], nextPage: null } });
      return;
    }

    if (url.pathname === '/v1/activations' && method === 'GET') {
      await route.fulfill({
        json: { items: [activation], total: 1, page: 1, nextPage: null },
      });
      return;
    }

    if (url.pathname === '/v1/activations/activation-1') {
      await route.fulfill({ json: activation });
      return;
    }

    if (url.pathname === '/v1/statistics' && method === 'GET') {
      await route.fulfill({
        json: { items: [], total: 0, page: 1, nextPage: null },
      });
      return;
    }

    if (url.pathname === '/v1/notifications') {
      await route.fulfill({ json: { items: [] } });
      return;
    }

    if (url.pathname === '/v1/statistics/rebuild-jobs' && method === 'POST') {
      rebuildRequests.push({
        body: request.postDataJSON(),
        idempotencyKey: request.headers()['idempotency-key'] || '',
      });
      await route.fulfill({ status: 202, json: rebuildJob });
      return;
    }

    if (url.pathname === '/v1/statistics/rebuild-jobs/rebuild-1') {
      rebuildJob = { ...rebuildJob, status: 'SUCCEEDED', attempts: 1 };
      await route.fulfill({ json: rebuildJob });
      return;
    }

    await route.fulfill({
      json: { items: [], total: 0, page: 1, nextPage: null },
    });
  });

  await page.goto('/activity');
  await expect(page).toHaveURL(/\/login\?redirect=\/activity$/);
  await page.getByLabel('Email').fill('activity-admin@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/activity$/);

  await page.getByRole('button', { name: /DL1ABC/ }).click();
  await expect(page.getByRole('heading', { name: 'QSOs (1)' })).toBeVisible();
  await expect(page.getByText('F4XYZ')).toBeVisible();
  await expect(page.getByText('20m · SSB')).toBeVisible();

  await page.getByRole('button', { name: 'Rebuild statistics' }).click();
  const rebuildStatus = page.locator('.activity-job');
  await expect(rebuildStatus).toHaveAttribute('role', 'status');
  await expect(rebuildStatus).toHaveAttribute('aria-live', 'polite');
  await expect(rebuildStatus).toHaveAttribute('aria-atomic', 'true');
  await expect(rebuildStatus).toContainText('rebuild-1');
  await expect(rebuildStatus).toContainText('QUEUED');
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await expect(rebuildStatus).toContainText('SUCCEEDED');
  expect(rebuildRequests).toHaveLength(1);
  expect(rebuildRequests[0].body).toEqual({ programmeSlug: null });
  expect(rebuildRequests[0].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
});
