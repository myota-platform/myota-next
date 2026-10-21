import { expect, test } from '@playwright/test';

test('filters and reviews QSO correction requests with the affected QSO context', async ({
  page,
}) => {
  const corrections = [
    {
      id: 'correction-1',
      qsoId: 'qso-1',
      requestedBy: 'participant-1',
      reason: 'The worked callsign was entered incorrectly.',
      proposedValues: { workedCallsign: 'F4XYZ' },
      status: 'PENDING',
      programmeSlug: 'alpine',
      entityId: 'summit-1',
      qso: {
        activationId: 'activation-1',
        operatorCallsign: 'DL1ABC',
        workedCallsign: 'F4XYY',
        timestamp: '2026-10-20T08:30:00.000Z',
        band: '20m',
        mode: 'SSB',
      },
    },
    {
      id: 'correction-2',
      qsoId: 'qso-2',
      requestedBy: 'participant-2',
      reason: 'The contact did not take place.',
      proposedValues: { status: 'INVALID' },
      status: 'PENDING',
      programmeSlug: 'alpine',
      entityId: 'summit-2',
      qso: {
        activationId: 'activation-2',
        operatorCallsign: 'DL1DEF',
        workedCallsign: 'G4ABC',
        timestamp: '2026-10-20T09:30:00.000Z',
        band: '40m',
        mode: 'CW',
      },
    },
    ...Array.from({ length: 19 }, (_, index) => ({
      id: `correction-${index + 3}`,
      qsoId: `qso-${index + 3}`,
      requestedBy: `participant-${index + 3}`,
      reason: 'Additional request for paging coverage.',
      proposedValues: { workedCallsign: `K${index + 1}FILL` },
      status: 'PENDING',
      programmeSlug: 'alpine',
      entityId: `summit-${index + 3}`,
      qso: {
        activationId: `activation-${index + 3}`,
        operatorCallsign: 'DL1ABC',
        workedCallsign: `K${index + 1}FILL`,
        timestamp: '2026-10-20T10:30:00.000Z',
        band: '20m',
        mode: 'SSB',
      },
    })),
  ];
  const reviewRequests: Array<{
    path: string;
    authorization: string;
    body: Record<string, unknown>;
  }> = [];
  const inboxQueries: URLSearchParams[] = [];

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'activity-review-access-token',
          refreshToken: 'activity-review-refresh-token',
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
        json: { items: [], page: 1, total: 0, nextPage: null },
      });
      return;
    }

    if (url.pathname === '/v1/statistics' && method === 'GET') {
      await route.fulfill({
        json: { items: [], page: 1, total: 0, nextPage: null },
      });
      return;
    }

    if (url.pathname === '/v1/notifications') {
      await route.fulfill({ json: { items: [] } });
      return;
    }

    if (url.pathname === '/v1/qso-corrections' && method === 'GET') {
      inboxQueries.push(url.searchParams);
      const status = url.searchParams.get('status') || 'PENDING';
      const items = corrections.filter(
        (correction) => status === 'ALL' || correction.status === status,
      );
      const pageNumber = Number(url.searchParams.get('page') || 1);
      const pageSize = Number(url.searchParams.get('pageSize') || 20);
      await route.fulfill({
        json: {
          items: items.slice(
            (pageNumber - 1) * pageSize,
            pageNumber * pageSize,
          ),
          page: pageNumber,
          total: items.length,
          nextPage:
            pageNumber * pageSize < items.length ? pageNumber + 1 : null,
        },
      });
      return;
    }

    if (
      url.pathname.startsWith('/v1/qsos/') &&
      url.pathname.includes('/corrections/') &&
      url.pathname.endsWith('/review') &&
      method === 'POST'
    ) {
      const body = request.postDataJSON() as Record<string, unknown>;
      reviewRequests.push({
        path: url.pathname,
        authorization: request.headers().authorization || '',
        body,
      });
      const correctionId = url.pathname.split('/').at(-2);
      const correction = corrections.find((item) => item.id === correctionId);
      if (correction) correction.status = body.decision as string;
      await route.fulfill({ status: 200, json: correction || {} });
      return;
    }

    await route.fulfill({
      json: { items: [], page: 1, total: 0, nextPage: null },
    });
  });

  const confirmations: string[] = [];
  page.on('dialog', async (dialog) => {
    confirmations.push(dialog.message());
    await dialog.accept();
  });

  await page.goto('/activity');
  await expect(page).toHaveURL(/\/login\?redirect=\/activity$/);
  await page.getByLabel('Email').fill('activity-admin@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/activity$/);

  const firstCard = page
    .locator('.correction-card')
    .filter({ hasText: 'F4XYY' });
  const secondCard = page
    .locator('.correction-card')
    .filter({ hasText: 'G4ABC' });
  await expect(firstCard).toContainText('Requested by participant-1');
  await expect(firstCard).toContainText('Operator DL1ABC');
  await expect(firstCard).toContainText(
    'The worked callsign was entered incorrectly.',
  );
  await expect(firstCard).toContainText('F4XYZ');
  await expect(secondCard).toBeVisible();
  await expect(page.locator('.correction-card')).toHaveCount(20);
  await page
    .getByRole('button', { name: 'Next page of correction requests' })
    .click();
  await expect(page.locator('.correction-card')).toHaveCount(1);
  await expect(page.locator('.correction-card')).toContainText('K19FILL');
  await page
    .getByRole('button', { name: 'Previous page of correction requests' })
    .click();
  await expect(page.locator('.correction-card')).toHaveCount(20);

  await firstCard
    .getByLabel('Review note (optional)')
    .fill('Confirmed from the submitted log.');
  await firstCard.getByRole('button', { name: 'Apply correction' }).click();
  await expect(page.getByText('QSO correction applied.')).toBeVisible();
  await expect(page.locator('.correction-card')).toHaveCount(20);

  await secondCard
    .getByLabel('Review note (optional)')
    .fill('No supporting contact record.');
  await secondCard.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByText('QSO correction rejected.')).toBeVisible();
  await expect(page.locator('.correction-card')).toHaveCount(19);

  await page.getByLabel('Status').selectOption('ALL');
  await expect(page.locator('.correction-card')).toHaveCount(20);
  await expect(
    page.locator('.correction-card').filter({ hasText: 'APPLIED' }),
  ).toBeVisible();
  await expect(
    page.locator('.correction-card').filter({ hasText: 'REJECTED' }),
  ).toBeVisible();

  expect(confirmations).toEqual([
    'Are you sure you want to apply the correction for F4XYY? This will update the QSO and queue award recalculation.',
    'Are you sure you want to reject the correction for G4ABC? This will close the request without changing the QSO.',
  ]);
  expect(reviewRequests).toEqual([
    {
      path: '/v1/qsos/qso-1/corrections/correction-1/review',
      authorization: 'Bearer activity-review-access-token',
      body: {
        decision: 'APPLIED',
        reviewedBy: 'activity-admin-1',
        reviewNote: 'Confirmed from the submitted log.',
      },
    },
    {
      path: '/v1/qsos/qso-2/corrections/correction-2/review',
      authorization: 'Bearer activity-review-access-token',
      body: {
        decision: 'REJECTED',
        reviewedBy: 'activity-admin-1',
        reviewNote: 'No supporting contact record.',
      },
    },
  ]);
  expect(inboxQueries.some((query) => query.get('status') === 'ALL')).toBe(
    true,
  );
});
