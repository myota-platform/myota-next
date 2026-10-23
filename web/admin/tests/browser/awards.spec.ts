import { expect, test } from '@playwright/test';
import { expectResponsiveAccessible } from '../../../a11y';

test('queues broad award progress recalculation and shows terminal job state', async ({
  page,
}) => {
  const requests: Array<{
    method: string;
    body?: Record<string, unknown>;
    key?: string;
  }> = [];
  let statusReads = 0;
  const award = {
    id: 'award-live-1',
    programmeSlug: 'alpine',
    code: 'ALPINE-LIVE',
    name: 'Alpine award',
    category: 'HUNTER',
    status: 'PUBLISHED',
    version: 3,
    condition: {},
    levels: [],
    template: { elements: [] },
  };

  page.on('dialog', (dialog) => dialog.accept());
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({ json: { accessToken: 'award-admin-token' } });
      return;
    }
    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'award-admin',
          email: 'award-admin@example.test',
          displayName: 'Award Admin',
          scopes: ['awards.admin'],
        },
      });
      return;
    }
    if (url.pathname === '/v1/programmes') {
      await route.fulfill({
        json: { items: [{ slug: 'alpine', name: 'Alpine' }], nextPage: null },
      });
      return;
    }
    if (url.pathname === '/v1/awards' && method === 'GET') {
      await route.fulfill({
        json: {
          items: [award],
          page: 1,
          pageSize: 50,
          total: 1,
          nextPage: null,
        },
      });
      return;
    }
    if (url.pathname === '/v1/awards/award-live-1' && method === 'GET') {
      await route.fulfill({ json: award });
      return;
    }
    if (url.pathname === '/v1/awards/assets') {
      await route.fulfill({ json: { items: [], nextPage: null } });
      return;
    }
    if (
      url.pathname === '/v1/awards/requests' ||
      url.pathname === '/v1/awards/issuances'
    ) {
      await route.fulfill({
        json: { items: [], page: 1, pageSize: 50, total: 0 },
      });
      return;
    }
    if (
      url.pathname === '/v1/awards/award-live-1/recalculation-jobs' &&
      method === 'POST'
    ) {
      requests.push({
        method,
        body: request.postDataJSON() as Record<string, unknown>,
        key: request.headers()['idempotency-key'],
      });
      await route.fulfill({
        status: 202,
        json: {
          awardId: award.id,
          jobId: 'award-job-1',
          status: 'QUEUED',
          attempts: 0,
        },
      });
      return;
    }
    if (
      url.pathname === '/v1/awards/award-live-1/recalculation-jobs/award-job-1'
    ) {
      statusReads += 1;
      await route.fulfill({
        json: {
          id: 'award-job-1',
          status: statusReads === 1 ? 'RUNNING' : 'SUCCEEDED',
          attempts: 1,
          lastError: null,
          completedAt: statusReads > 1 ? '2026-10-23T10:00:00.000Z' : null,
        },
      });
      return;
    }
    await route.fulfill({
      json: { items: [], page: 1, total: 0, nextPage: null },
    });
  });

  await page.goto('/awards');
  await page.getByLabel('Email').fill('award-admin@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/awards$/);
  await page.getByRole('button', { name: /Alpine award/ }).click();
  await expect(
    page.getByRole('heading', { name: 'Participant progress' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Recalculate all progress' }).click();
  await expect(page.getByText('QUEUED', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Request accepted; recalculation is queued.'),
  ).toBeVisible();
  await expect.poll(() => requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    method: 'POST',
    body: { subjectIds: [] },
  });
  expect(requests[0].key).toMatch(/^[0-9a-f-]{36}$/i);
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await expect(page.getByText('RUNNING', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await expect(page.getByText('SUCCEEDED', { exact: true })).toBeVisible();
  await expect(page.getByText('Recalculation completed.')).toBeVisible();
  await expectResponsiveAccessible(page, 'Admin broad award recalculation');
});

test('saves an award draft and submits it for review', async ({ page }) => {
  const saveRequests: Array<{ body: Record<string, any>; key: string }> = [];
  const actionRequests: unknown[] = [];
  let award: Record<string, any> | null = null;
  let failFirstSave = true;

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = method === 'GET' ? null : request.postDataJSON();

    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'admin-awards-access-token',
          refreshToken: 'admin-awards-refresh-token',
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'awards-admin-1',
          email: 'awards-admin@example.test',
          displayName: 'Awards Admin',
          scopes: ['awards.admin'],
        },
      });
      return;
    }

    if (url.pathname === '/v1/programmes') {
      await route.fulfill({
        json: {
          items: [{ slug: 'alpine', name: 'Alpine Summits', description: '' }],
          nextPage: null,
        },
      });
      return;
    }

    if (url.pathname === '/v1/awards' && method === 'GET') {
      await route.fulfill({
        json: {
          items: award ? [award] : [],
          page: 1,
          pageSize: 50,
          total: award ? 1 : 0,
          nextPage: null,
        },
      });
      return;
    }

    if (url.pathname === '/v1/awards/assets') {
      await route.fulfill({ json: { items: [], nextPage: null } });
      return;
    }

    if (url.pathname === '/v1/awards/requests') {
      await route.fulfill({
        json: { items: [], page: 1, pageSize: 50, total: 0, nextPage: null },
      });
      return;
    }

    if (url.pathname === '/v1/awards/issuances') {
      await route.fulfill({
        json: { items: [], page: 1, pageSize: 50, total: 0, nextPage: null },
      });
      return;
    }

    if (url.pathname === '/v1/awards' && method === 'POST') {
      saveRequests.push({
        body: body as Record<string, any>,
        key: request.headers()['idempotency-key'] || '',
      });
      award = {
        ...(body as Record<string, unknown>),
        id: 'award-1',
        status: 'DRAFT',
      };
      if (failFirstSave) {
        failFirstSave = false;
        await route.fulfill({
          status: 503,
          json: { message: 'temporary award save response failure' },
        });
        return;
      }
      await route.fulfill({ status: 201, json: award });
      return;
    }

    if (url.pathname === '/v1/awards/award-1' && method === 'GET') {
      await route.fulfill({ json: award });
      return;
    }

    if (url.pathname === '/v1/awards/award-1' && method === 'PATCH') {
      actionRequests.push(body);
      award = { ...award, ...(body as Record<string, unknown>) };
      await route.fulfill({ json: award });
      return;
    }

    await route.fulfill({
      json: { items: [], page: 1, total: 0, nextPage: null },
    });
  });

  await page.goto('/awards');
  await expect(page).toHaveURL(/\/login\?redirect=\/awards$/);
  await page.getByLabel('Email').fill('awards-admin@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/awards$/);

  await page.getByLabel('Code', { exact: true }).fill('ALPINE-10');
  await page.getByLabel('Name', { exact: true }).fill('Alpine Ten Contacts');
  await page
    .getByLabel('Description', { exact: true })
    .fill('Complete ten eligible contacts.');
  await page.getByRole('button', { name: 'Save award draft' }).click();
  await expect(
    page.getByText('temporary award save response failure'),
  ).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/\/awards$/);
  await page.getByLabel('Code', { exact: true }).fill('ALPINE-10');
  await page.getByLabel('Name', { exact: true }).fill('Alpine Ten Contacts');
  await page
    .getByLabel('Description', { exact: true })
    .fill('Complete ten eligible contacts.');
  await page.getByRole('button', { name: 'Save award draft' }).click();

  await expect(page.getByText('Award draft saved.')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Submit for review' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('button', { name: 'Publish' })).toBeVisible();
  await page.getByLabel('Effective from (UTC)').fill('2026-10-21T12:00');
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Award published.')).toBeVisible();

  expect(saveRequests).toHaveLength(2);
  expect(saveRequests[0].key).toMatch(/^[0-9a-f-]{36}$/i);
  expect(saveRequests[1].key).toBe(saveRequests[0].key);
  expect(saveRequests[1].body).toEqual(saveRequests[0].body);
  expect(saveRequests[0].body).toMatchObject({
    programmeSlug: 'alpine',
    code: 'ALPINE-10',
    name: 'Alpine Ten Contacts',
    category: 'HUNTER',
    achievementMetric: 'QSO_COUNT',
    condition: {
      kind: 'AND',
      conditions: [{ kind: 'QSO_COUNT', operator: 'GTE', value: 10 }],
    },
    levels: [{ id: 'level-10', name: '10 contacts', threshold: 10 }],
  });
  expect(actionRequests).toEqual([
    { status: 'UNDER_REVIEW', submitterId: 'awards-admin-1' },
    {
      status: 'APPROVED',
      reviewerId: 'awards-admin-1',
    },
    {
      status: 'PUBLISHED',
      effectiveFrom: '2026-10-21T12:00:00.000Z',
      publisherId: 'awards-admin-1',
    },
  ]);
});
