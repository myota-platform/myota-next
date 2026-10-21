import { expect, test } from '@playwright/test';

test('retries a content draft after reload and completes its review lifecycle', async ({
  page,
}) => {
  const saveRequests: Array<{ body: Record<string, unknown>; key: string }> =
    [];
  const lifecycleRequests: Array<Record<string, unknown>> = [];
  let content: Record<string, any> | null = null;
  let failFirstSave = true;

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'admin-content-access-token',
          refreshToken: 'admin-content-refresh-token',
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'content-admin-1',
          email: 'content-admin@example.test',
          displayName: 'Content Admin',
          scopes: ['programme.admin'],
        },
      });
      return;
    }

    if (url.pathname === '/v1/programmes') {
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

    if (url.pathname === '/v1/programmes/alpine/content/coverage') {
      await route.fulfill({ json: { locales: [] } });
      return;
    }

    if (url.pathname === '/v1/programmes/alpine/content' && method === 'GET') {
      await route.fulfill({
        json: {
          items: content ? [content] : [],
          page: 1,
          total: content ? 1 : 0,
          nextPage: null,
        },
      });
      return;
    }

    if (url.pathname === '/v1/programmes/alpine/content' && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      saveRequests.push({
        body,
        key: request.headers()['idempotency-key'] || '',
      });
      content = {
        ...body,
        id: 'content-1',
        status: 'DRAFT',
        fallbackLocale: null,
      };
      if (failFirstSave) {
        failFirstSave = false;
        await route.fulfill({
          status: 503,
          json: { message: 'temporary content save response failure' },
        });
        return;
      }
      await route.fulfill({ status: 201, json: content });
      return;
    }

    if (
      url.pathname === '/v1/programmes/alpine/content/content-1' &&
      method === 'PATCH'
    ) {
      const body = request.postDataJSON() as Record<string, unknown>;
      lifecycleRequests.push(body);
      content = { ...content, ...body };
      await route.fulfill({ json: content });
      return;
    }

    await route.fulfill({
      json: { items: [], page: 1, total: 0, nextPage: null },
    });
  });

  await page.goto('/content');
  await expect(page).toHaveURL(/\/login\?redirect=\/content$/);
  await page.getByLabel('Email').fill('content-admin@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/content$/);

  const fillDraft = async () => {
    await page.getByLabel('Content key').fill('programme.description');
    await page.getByLabel('Locale', { exact: true }).fill('en');
    await page.getByLabel('Fallback locale').fill('');
    await page
      .getByLabel('Text or content value')
      .fill('Activate from the alpine summits.');
  };

  await fillDraft();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(
    page.getByText('temporary content save response failure'),
  ).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/\/content$/);
  await expect(
    page.getByRole('heading', { name: 'New content draft' }),
  ).toBeVisible();
  await fillDraft();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Content draft saved.')).toBeVisible();

  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('button', { name: 'Publish' })).toBeVisible();
  await page.getByLabel('Effective from (UTC)').fill('2026-10-21T12:00');
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Content published.')).toBeVisible();

  expect(saveRequests).toHaveLength(2);
  expect(saveRequests[0].key).toMatch(/^[0-9a-f-]{36}$/i);
  expect(saveRequests[1].key).toBe(saveRequests[0].key);
  expect(saveRequests[1].body).toEqual(saveRequests[0].body);
  expect(saveRequests[0].body).toEqual({
    key: 'programme.description',
    locale: 'en',
    fallbackLocale: null,
    value: 'Activate from the alpine summits.',
  });
  expect(lifecycleRequests).toEqual([
    { status: 'UNDER_REVIEW', submitterId: 'content-admin-1' },
    { status: 'APPROVED', reviewerId: 'content-admin-1' },
    {
      status: 'PUBLISHED',
      effectiveFrom: '2026-10-21T12:00:00.000Z',
      publisherId: 'content-admin-1',
    },
  ]);
});
