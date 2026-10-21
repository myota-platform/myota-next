import { expect, test } from '@playwright/test';

test('manages an account callsign lifecycle with evidence and a primary replacement', async ({
  page,
}) => {
  const account: Record<string, any> = {
    id: 'account-1',
    displayName: 'Casey Operator',
    email: 'casey@example.test',
    status: 'ACTIVE',
    participationType: 'OPERATOR',
    primaryCallsignId: 'callsign-old',
    callsigns: [
      {
        id: 'callsign-old',
        value: 'DL1OLD',
        status: 'VERIFIED',
        evidenceIds: [],
      },
    ] as Array<Record<string, any>>,
    roles: [],
    scopes: ['identity.admin', 'callsign.verify'],
  };
  const mutations: Array<{
    method: string;
    path: string;
    authorization: string;
    key: string;
    body: unknown;
  }> = [];

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'admin-callsign-access-token',
          refreshToken: 'admin-callsign-refresh-token',
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({ json: account });
      return;
    }

    if (url.pathname === '/v1/identity/admin/accounts') {
      await route.fulfill({
        json: { items: [account], page: 1, total: 1, nextPage: null },
      });
      return;
    }

    if (
      url.pathname === '/v1/identity/admin/roles' ||
      url.pathname === '/v1/identity/admin/security-events'
    ) {
      await route.fulfill({
        json: { items: [], permissions: [], page: 1, total: 0, nextPage: null },
      });
      return;
    }

    if (url.pathname.startsWith('/v1/identity/accounts/account-1/')) {
      const body = method === 'GET' ? null : request.postDataJSON();
      mutations.push({
        method,
        path: url.pathname,
        authorization: request.headers().authorization || '',
        key: request.headers()['idempotency-key'] || '',
        body,
      });

      if (url.pathname.endsWith('/callsigns') && method === 'POST') {
        account.callsigns.push({
          ...(body as Record<string, unknown>),
          id: 'callsign-new',
          value: String((body as Record<string, unknown>).callsign),
          status: 'UNVERIFIED',
          evidenceIds: [],
        });
      } else if (url.pathname.endsWith('/evidence') && method === 'POST') {
        account.callsigns
          .find((item: Record<string, any>) => item.id === 'callsign-new')
          ?.evidenceIds.push('evidence-1');
      } else if (url.pathname.endsWith('/verify') && method === 'POST') {
        const callsign = account.callsigns.find(
          (item: Record<string, any>) => item.id === 'callsign-new',
        );
        if (callsign) {
          callsign.status = 'VERIFIED';
          callsign.verificationSource = (body as Record<string, string>).source;
        }
      } else if (
        url.pathname.endsWith('/primary-callsign') &&
        method === 'PUT'
      ) {
        account.primaryCallsignId = (body as { callsignId: string }).callsignId;
      } else if (url.pathname.endsWith('/retire') && method === 'POST') {
        const callsign = account.callsigns.find((item: Record<string, any>) =>
          url.pathname.includes(encodeURIComponent(item.id)),
        );
        if (callsign) callsign.status = 'RETIRED';
        account.primaryCallsignId = (
          body as { newPrimaryCallsignId: string }
        ).newPrimaryCallsignId;
      }

      const status =
        url.pathname.endsWith('/verify') || url.pathname.endsWith('/retire')
          ? 200
          : method === 'POST'
            ? 201
            : 200;
      await route.fulfill({ status, json: account });
      return;
    }

    await route.fulfill({
      json: { items: [], page: 1, total: 0, nextPage: null },
    });
  });

  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/identity');
  await expect(page).toHaveURL(/\/login\?redirect=\/identity$/);
  await page.getByLabel('Email').fill('casey@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Search users').fill('Casey');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: /Casey Operator/ }).click();

  const callsignRows = page.locator('.callsign-management .callsign-row');
  const addForm = page.locator('.callsign-management form').first();
  await addForm.getByLabel('Callsign').fill('DL1NEW');
  await addForm.getByLabel('Initial status').selectOption('UNVERIFIED');
  await addForm.getByLabel('Source').fill('operator-asserted');
  await addForm.getByRole('button', { name: 'Add callsign' }).click();
  await expect(callsignRows.filter({ hasText: 'DL1NEW' })).toBeVisible();

  const evidenceForm = page.locator('.callsign-management form').nth(1);
  await evidenceForm.getByLabel('Callsign').selectOption('callsign-new');
  await evidenceForm.getByLabel('Evidence type').fill('LICENSE');
  await evidenceForm.getByLabel('Source').fill('regulator record');
  await evidenceForm
    .getByLabel('Metadata JSON (optional)')
    .fill('{"reference":"AB-123"}');
  await evidenceForm.getByRole('button', { name: 'Submit evidence' }).click();
  await expect(
    callsignRows.filter({ hasText: '1 evidence record' }),
  ).toBeVisible();

  await page.getByLabel('Verification source').fill('manual-review');
  await callsignRows
    .filter({ hasText: 'DL1NEW' })
    .getByRole('button', { name: 'Verify' })
    .click();
  await expect(
    callsignRows.filter({ hasText: 'Verified by manual-review' }),
  ).toBeVisible();

  await callsignRows
    .filter({ hasText: 'DL1NEW' })
    .getByRole('button', { name: 'Make primary' })
    .click();
  await expect(callsignRows.filter({ hasText: 'DL1NEW' })).toContainText(
    'Primary',
  );
  await callsignRows
    .filter({ hasText: 'DL1OLD' })
    .getByRole('button', { name: 'Make primary' })
    .click();

  await callsignRows
    .filter({ hasText: 'DL1OLD' })
    .getByRole('button', { name: 'Retire' })
    .click();
  await page
    .getByLabel('Replacement primary callsign')
    .selectOption('callsign-new');
  await page.getByRole('button', { name: 'Retire callsign' }).click();
  await expect(callsignRows.filter({ hasText: 'DL1OLD' })).toContainText(
    'RETIRED',
  );

  expect(
    mutations.map(({ method, path, body }) => ({ method, path, body })),
  ).toEqual([
    {
      method: 'POST',
      path: '/v1/identity/accounts/account-1/callsigns',
      body: {
        callsign: 'DL1NEW',
        status: 'UNVERIFIED',
        source: 'operator-asserted',
      },
    },
    {
      method: 'POST',
      path: '/v1/identity/accounts/account-1/callsigns/callsign-new/evidence',
      body: {
        evidenceType: 'LICENSE',
        source: 'regulator record',
        metadata: { reference: 'AB-123' },
      },
    },
    {
      method: 'POST',
      path: '/v1/identity/accounts/account-1/callsigns/callsign-new/verify',
      body: { source: 'manual-review' },
    },
    {
      method: 'PUT',
      path: '/v1/identity/accounts/account-1/primary-callsign',
      body: { callsignId: 'callsign-new' },
    },
    {
      method: 'PUT',
      path: '/v1/identity/accounts/account-1/primary-callsign',
      body: { callsignId: 'callsign-old' },
    },
    {
      method: 'POST',
      path: '/v1/identity/accounts/account-1/callsigns/callsign-old/retire',
      body: { newPrimaryCallsignId: 'callsign-new' },
    },
  ]);
  expect(mutations[0].key).toMatch(/^[0-9a-f-]{36}$/i);
  expect(mutations[3].key).toMatch(/^[0-9a-f-]{36}$/i);
  expect(mutations[4].key).toMatch(/^[0-9a-f-]{36}$/i);
  expect(
    mutations.every(
      (mutation) =>
        mutation.authorization === 'Bearer admin-callsign-access-token',
    ),
  ).toBe(true);
});
