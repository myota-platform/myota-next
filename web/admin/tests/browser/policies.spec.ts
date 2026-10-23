import { expect, test } from '@playwright/test';

test('saves, reviews, and publishes a programme policy draft', async ({
  page,
}) => {
  const draftPosts: Array<{ body: unknown; key: string }> = [];
  const policyPatches: unknown[] = [];
  let policy: Record<string, any> | null = null;
  let failFirstSave = true;

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = method === 'GET' ? null : request.postDataJSON();

    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'admin-policy-access-token',
          refreshToken: 'admin-policy-refresh-token',
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'admin-1',
          email: 'admin@example.test',
          displayName: 'Policy Admin',
          roles: [{ role: 'programme-admin', scopes: ['programme.admin'] }],
        },
      });
      return;
    }

    if (url.pathname === '/v1/programmes' && method === 'GET') {
      await route.fulfill({
        json: {
          items: [
            {
              slug: 'alpine',
              name: 'Alpine Summits',
              description: 'Radio from the high country.',
            },
          ],
          nextPage: null,
        },
      });
      return;
    }

    if (
      url.pathname === '/v1/programmes/alpine/policy-drafts' &&
      method === 'GET'
    ) {
      await route.fulfill({
        json: {
          items: policy ? [policy] : [],
          page: 1,
          total: policy ? 1 : 0,
          nextPage: null,
        },
      });
      return;
    }

    if (
      url.pathname === '/v1/programmes/alpine/policy-drafts' &&
      method === 'POST'
    ) {
      draftPosts.push({
        body,
        key: request.headers()['idempotency-key'] || '',
      });
      policy = {
        ...(body as Record<string, unknown>),
        id: 'policy-1',
        status: 'DRAFT',
      };
      if (failFirstSave) {
        failFirstSave = false;
        await route.fulfill({
          status: 503,
          json: { message: 'temporary policy save response failure' },
        });
        return;
      }
      await route.fulfill({ status: 201, json: policy });
      return;
    }

    if (
      url.pathname === '/v1/programmes/alpine/policy-drafts/policy-1' &&
      method === 'PATCH'
    ) {
      policyPatches.push(body);
      policy = { ...policy, ...(body as Record<string, unknown>) };
      await route.fulfill({ json: policy });
      return;
    }

    await route.fulfill({ json: { items: [], nextPage: null, total: 0 } });
  });

  await page.goto('/policies');
  await expect(page).toHaveURL(/\/login\?redirect=\/policies$/);
  await page.getByLabel('Email').fill('admin@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/policies$/);

  await page.getByLabel('Name', { exact: true }).fill('Winter summit rules');
  await page
    .locator('textarea.code-editor')
    .fill('{"rules":{"minimumQsos":{"activation":5,"hunter":2}}}');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(
    page.getByText('temporary policy save response failure'),
  ).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/\/policies$/);
  await page.getByLabel('Name', { exact: true }).fill('Winter summit rules');
  await page
    .locator('textarea.code-editor')
    .fill('{"rules":{"minimumQsos":{"activation":5,"hunter":2}}}');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Policy draft saved.')).toBeVisible();
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();

  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('button', { name: 'Publish' })).toBeVisible();
  await page.getByLabel('Effective from (UTC)').fill('2026-10-21T12:00');
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Policy published.')).toBeVisible();

  expect(draftPosts).toHaveLength(2);
  expect(draftPosts[0].key).toMatch(/^[0-9a-f-]{36}$/i);
  expect(draftPosts[1].key).toBe(draftPosts[0].key);
  expect(draftPosts[1].body).toEqual(draftPosts[0].body);
  expect(draftPosts[0].body).toEqual({
    type: 'RULES',
    name: 'Winter summit rules',
    schema: { rules: { minimumQsos: { activation: 5, hunter: 2 } } },
    effectiveFrom: null,
  });
  expect(policyPatches).toEqual([
    {
      status: 'UNDER_REVIEW',
      submitterId: 'admin-1',
    },
    {
      status: 'APPROVED',
      reviewerId: 'admin-1',
      note: 'Reviewed in programme administration',
    },
    {
      status: 'PUBLISHED',
      effectiveFrom: '2026-10-21T12:00:00.000Z',
      publisherId: 'admin-1',
    },
  ]);
});
