import { expect, test } from '@playwright/test';

test('approves a candidate with a version-checked review decision', async ({
  page,
}) => {
  const reviewRequests: Array<{
    body: unknown;
    ifMatch: string;
    idempotencyKey: string;
  }> = [];
  let candidate = {
    id: 'candidate-1',
    version: 7,
    name: 'Example summit',
    status: 'CANDIDATE',
    entityType: 'SOTA',
    geometry: { type: 'Point', coordinates: [7.2, 46.1] },
    provenance: { adapter: 'community proposal' },
  };

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = method === 'GET' ? null : request.postDataJSON();

    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'admin-geodata-access-token',
          refreshToken: 'admin-geodata-refresh-token',
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'reviewer-1',
          email: 'reviewer@example.test',
          displayName: 'Geodata Reviewer',
          scopes: ['geodata.review'],
        },
      });
      return;
    }

    if (url.pathname === '/v1/programmes') {
      await route.fulfill({ json: { items: [], nextPage: null } });
      return;
    }

    if (url.pathname === '/v1/geodata/entities' && method === 'GET') {
      await route.fulfill({
        json: { items: [candidate], total: 1, page: 1, nextPage: null },
      });
      return;
    }

    if (url.pathname === '/v1/entity-types') {
      await route.fulfill({ json: { items: [] } });
      return;
    }

    if (url.pathname === '/v1/geodata/location-options') {
      await route.fulfill({ json: { continents: [] } });
      return;
    }

    if (url.pathname === '/v1/geodata/entities/candidate-1/audit') {
      await route.fulfill({ json: { items: [] } });
      return;
    }

    if (
      url.pathname === '/v1/geodata/entities/candidate-1/reviews' &&
      method === 'POST'
    ) {
      reviewRequests.push({
        body,
        ifMatch: request.headers()['if-match'] || '',
        idempotencyKey: request.headers()['idempotency-key'] || '',
      });
      candidate = { ...candidate, status: 'APPROVED', version: 8 };
      await route.fulfill({ status: 201, json: { id: 'review-1' } });
      return;
    }

    if (url.pathname === '/v1/geodata/entities/candidate-1') {
      await route.fulfill({ json: candidate });
      return;
    }

    await route.fulfill({
      json: { items: [], page: 1, total: 0, nextPage: null },
    });
  });

  await page.goto('/geodata');
  await expect(page).toHaveURL(/\/login\?redirect=\/geodata$/);
  await page.getByLabel('Email').fill('reviewer@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/geodata$/);

  await page
    .locator('button.entity-link')
    .filter({ hasText: 'Example summit' })
    .click();
  await page.locator('select').last().selectOption('APPROVED');
  await page
    .getByPlaceholder('Review note / decision evidence')
    .fill('Verified the summit location and source.');
  await page.getByRole('button', { name: 'Save review decision' }).click();

  await expect(page.getByText('Status changed to APPROVED.')).toBeVisible();
  await expect(page.locator('.status-pill.approved').first()).toHaveText(
    'APPROVED',
  );
  expect(reviewRequests).toEqual([
    {
      body: {
        status: 'APPROVED',
        reviewerId: 'reviewer-1',
        note: 'Verified the summit location and source.',
      },
      ifMatch: '"7"',
      idempotencyKey: expect.any(String),
    },
  ]);
  expect(reviewRequests[0].idempotencyKey).not.toBe('');
});
