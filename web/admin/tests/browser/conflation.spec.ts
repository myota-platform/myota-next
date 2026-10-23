import { expect, test } from '@playwright/test';

test('records a conflation decision with reviewer, survivor, and note', async ({
  page,
}) => {
  const resolutionRequests: unknown[] = [];
  const candidate: Record<string, any> = {
    id: 'match-1',
    leftEntityId: 'entity-old',
    rightEntityId: 'entity-current',
    leftEntity: {
      id: 'entity-old',
      name: 'Old summit record',
      status: 'APPROVED',
      geometry: { type: 'Point', coordinates: [7.2, 46.1] },
    },
    rightEntity: {
      id: 'entity-current',
      name: 'Current summit record',
      status: 'APPROVED',
      geometry: { type: 'Point', coordinates: [7.2001, 46.1001] },
    },
    score: 0.98,
    signals: { distanceMeters: 14 },
    resolution: 'OPEN',
    resolutionHistory: [],
    survivorEntityId: null,
  };

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'admin-conflation-access-token',
          refreshToken: 'admin-conflation-refresh-token',
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'geodata-reviewer-1',
          email: 'geodata-reviewer@example.test',
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

    if (url.pathname === '/v1/geodata/conflation' && method === 'GET') {
      await route.fulfill({
        json: { items: [candidate], page: 1, total: 1, nextPage: null },
      });
      return;
    }

    if (
      url.pathname === '/v1/geodata/conflation/match-1/resolve' &&
      method === 'POST'
    ) {
      resolutionRequests.push(request.postDataJSON());
      Object.assign(candidate, {
        resolution: 'KEPT_SEPARATE',
        survivorEntityId: 'entity-current',
        resolutionHistory: [
          {
            decision: 'KEPT_SEPARATE',
            reviewerId: 'geodata-reviewer-1',
            note: 'Distinct summit locations.',
            occurredAt: '2026-10-21T12:00:00Z',
          },
        ],
      });
      await route.fulfill({ status: 201, json: candidate });
      return;
    }

    await route.fulfill({
      json: { items: [], page: 1, total: 0, nextPage: null },
    });
  });

  await page.goto('/conflation');
  await expect(page).toHaveURL(/\/login\?redirect=\/conflation$/);
  await page.getByLabel('Email').fill('geodata-reviewer@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/conflation$/);

  const card = page.locator('.conflation-card');
  await expect(card).toContainText('Old summit record');
  await expect(card).toContainText('Current summit record');
  await card.getByLabel('Decision').selectOption('KEPT_SEPARATE');
  await card
    .getByLabel('Surviving entity (optional)')
    .selectOption('entity-current');
  await card.getByLabel('Review note').fill('Distinct summit locations.');
  await card.getByRole('button', { name: 'Record decision' }).click();

  await expect(page.locator('.success-text[role="status"]')).toContainText(
    'Resolution recorded for match-1.',
  );
  expect(resolutionRequests).toEqual([
    {
      decision: 'KEPT_SEPARATE',
      reviewerId: 'geodata-reviewer-1',
      survivorEntityId: 'entity-current',
      note: 'Distinct summit locations.',
    },
  ]);
});
