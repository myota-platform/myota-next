import { expect, test } from '@playwright/test';

test('Participant Administrator can manage only participants in a paged workspace', async ({
  page,
}) => {
  const updates: Array<Record<string, unknown>> = [];
  let conflictNextUpdate = false;
  let participant = {
    id: 'participant-1',
    displayName: 'Casey Operator',
    email: 'casey@example.test',
    emailVerified: true,
    status: 'ACTIVE',
    createdAt: '2026-10-26T09:00:00Z',
    updatedAt: '2026-10-26T09:00:00Z',
  };
  const secondPageParticipant = {
    ...participant,
    id: 'participant-51',
    displayName: 'Second page participant',
    email: 'second-page@example.test',
  };
  const firstPageParticipants = Array.from({ length: 49 }, (_, index) => ({
    ...participant,
    id: `participant-${index + 2}`,
    displayName: `Synthetic participant ${index + 2}`,
    email: `synthetic-${index + 2}@example.test`,
  }));

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
      const query = url.searchParams.get('q') || '';
      const requestedPage = Number(url.searchParams.get('page') || '1');
      expect(['', 'Casey', 'Casey Updated']).toContain(query);
      const items = query
        ? [participant].filter((item) =>
            `${item.displayName} ${item.email}`
              .toLowerCase()
              .includes(query.toLowerCase()),
          )
        : requestedPage === 2
          ? [secondPageParticipant]
          : [participant, ...firstPageParticipants];
      await route.fulfill({
        json: {
          items,
          page: requestedPage,
          pageSize: 50,
          total: query ? items.length : 51,
          nextPage: !query && requestedPage === 1 ? 2 : null,
        },
      });
      return;
    }
    if (
      url.pathname === '/v1/identity/admin/participants/participant-1' &&
      request.method() === 'PATCH'
    ) {
      if (conflictNextUpdate) {
        conflictNextUpdate = false;
        await route.fulfill({
          status: 409,
          json: {
            statusCode: 409,
            detail: 'Participant account changed; reload and retry.',
          },
        });
        return;
      }
      const body = request.postDataJSON() as Record<string, unknown>;
      updates.push(body);
      participant = {
        ...participant,
        ...(typeof body.displayName === 'string'
          ? { displayName: body.displayName }
          : {}),
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
  await expect(
    page.getByRole('button', { name: 'Next', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Second page participant' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await page.getByLabel('Search participants').fill('Casey');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button', { name: 'Casey Operator' }).click();
  await expect(
    page.getByRole('definition').filter({ hasText: 'Verified' }),
  ).toBeVisible();
  await page.getByLabel('Display name').fill('Casey Updated');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(
    page.getByRole('heading', { name: 'Casey Updated' }),
  ).toBeVisible();
  await expect(page.getByText('Participant account updated.')).toBeVisible();

  await page.reload();
  await page.getByLabel('Search participants').fill('Casey Updated');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button', { name: 'Casey Updated' }).click();
  await expect(page.getByLabel('Display name')).toHaveValue('Casey Updated');

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Suspend sign-in' }).click();
  await expect(
    page.getByRole('definition').filter({ hasText: 'SUSPENDED' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Reactivate sign-in' }).click();
  await expect(
    page.getByRole('definition').filter({ hasText: 'ACTIVE' }),
  ).toBeVisible();

  conflictNextUpdate = true;
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Suspend sign-in' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Participant account changed; reload and retry.',
  );
  await expect(
    page.getByRole('definition').filter({ hasText: 'ACTIVE' }),
  ).toBeVisible();

  expect(updates).toEqual([
    { displayName: 'Casey Updated' },
    { status: 'SUSPENDED' },
    { status: 'ACTIVE' },
  ]);
  await expect(
    page.getByText(
      'Administrator accounts, role grants, and role definitions are outside this workspace.',
    ),
  ).toBeVisible();

  await page.goto('/identity');
  await expect(page).toHaveURL(/\/access-denied$/);
  await expect(
    page.getByRole('heading', { name: 'Access not available' }),
  ).toBeVisible();
});
