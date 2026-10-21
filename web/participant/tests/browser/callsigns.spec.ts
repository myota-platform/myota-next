import { expect, test } from '@playwright/test';

test('lets an operator manage callsigns, evidence, and primary retirement', async ({
  page,
}) => {
  const account: Record<string, any> = {
    id: 'participant-1',
    email: 'operator@example.test',
    displayName: 'Operator One',
    primaryCallsignId: 'callsign-old',
    callsigns: [
      {
        id: 'callsign-old',
        value: 'DL1OLD',
        status: 'VERIFIED',
        evidenceIds: [],
      },
    ],
    profileImage: null,
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

    if (url.pathname === '/v1/programmes') {
      await route.fulfill({ json: { items: [], nextPage: null } });
      return;
    }

    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'participant-callsign-access-token',
          refreshToken: 'participant-callsign-refresh-token',
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({ json: account });
      return;
    }

    if (url.pathname.startsWith('/v1/identity/accounts/participant-1/')) {
      const body = method === 'GET' ? null : request.postDataJSON();
      mutations.push({
        method,
        path: url.pathname,
        authorization: request.headers().authorization || '',
        key: request.headers()['idempotency-key'] || '',
        body,
      });

      if (url.pathname.endsWith('/callsigns') && method === 'POST') {
        const value = (body as { callsign: string }).callsign;
        account.callsigns.push({
          id: 'callsign-new',
          value,
          status: 'UNVERIFIED',
          evidenceIds: [],
        });
      } else if (url.pathname.endsWith('/evidence') && method === 'POST') {
        account.callsigns
          .find((item: { id: string }) => item.id === 'callsign-new')
          ?.evidenceIds.push('evidence-1');
      } else if (
        url.pathname.endsWith('/primary-callsign') &&
        method === 'PUT'
      ) {
        account.primaryCallsignId = (body as { callsignId: string }).callsignId;
      } else if (url.pathname.endsWith('/retire') && method === 'POST') {
        const callsign = account.callsigns.find((item: { id: string }) =>
          url.pathname.includes(encodeURIComponent(item.id)),
        );
        if (callsign) callsign.status = 'RETIRED';
        account.primaryCallsignId = (
          body as { newPrimaryCallsignId: string }
        ).newPrimaryCallsignId;
      }

      const status = url.pathname.endsWith('/retire')
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
  await page.goto('http://127.0.0.1:8091');
  await page.locator('#award-email').fill('operator@example.test');
  await page.locator('#award-password').fill('test-password');
  await page.locator('#award-login button[type="submit"]').click();
  await expect(page.locator('#profile-callsigns')).toBeVisible();

  await page.locator('#profile-callsign-value').fill('DL1NEW');
  await page.locator('#profile-callsign-add button[type="submit"]').click();
  await expect(page.locator('#profile-status')).toHaveText('Callsign added.');

  await page.locator('#profile-evidence-callsign').selectOption('callsign-new');
  await page.locator('#profile-evidence-type').fill('LICENSE');
  await page.locator('#profile-evidence-source').fill('regulator record');
  await page.locator('#profile-evidence-checksum').fill('sha256:abc123');
  await page
    .locator('#profile-evidence-metadata')
    .fill('{"reference":"AB-123"}');
  await page
    .locator('#profile-callsign-evidence button[type="submit"]')
    .click();
  await expect(page.locator('#profile-status')).toHaveText(
    'Callsign evidence submitted.',
  );

  const newCallsign = page
    .locator('.profile-callsign-row')
    .filter({ hasText: 'DL1NEW' });
  await newCallsign.getByRole('button', { name: 'Make primary' }).click();
  await expect(newCallsign).toContainText('Primary');
  const oldCallsign = page
    .locator('.profile-callsign-row')
    .filter({ hasText: 'DL1OLD' });
  await oldCallsign.getByRole('button', { name: 'Make primary' }).click();
  await expect(oldCallsign).toContainText('Primary');

  await oldCallsign.getByRole('button', { name: 'Retire' }).click();
  await page
    .locator('#profile-retire-replacement')
    .selectOption('callsign-new');
  await page.locator('#profile-callsign-retire button[type="submit"]').click();
  await expect(page.locator('#profile-status')).toHaveText('Callsign retired.');
  await expect(oldCallsign).toContainText('RETIRED');
  await expect(newCallsign).toContainText('Primary');

  expect(
    mutations.map(({ method, path, body }) => ({ method, path, body })),
  ).toEqual([
    {
      method: 'POST',
      path: '/v1/identity/accounts/participant-1/callsigns',
      body: { callsign: 'DL1NEW' },
    },
    {
      method: 'POST',
      path: '/v1/identity/accounts/participant-1/callsigns/callsign-new/evidence',
      body: {
        evidenceType: 'LICENSE',
        source: 'regulator record',
        checksum: 'sha256:abc123',
        metadata: { reference: 'AB-123' },
      },
    },
    {
      method: 'PUT',
      path: '/v1/identity/accounts/participant-1/primary-callsign',
      body: { callsignId: 'callsign-new' },
    },
    {
      method: 'PUT',
      path: '/v1/identity/accounts/participant-1/primary-callsign',
      body: { callsignId: 'callsign-old' },
    },
    {
      method: 'POST',
      path: '/v1/identity/accounts/participant-1/callsigns/callsign-old/retire',
      body: { newPrimaryCallsignId: 'callsign-new' },
    },
  ]);
  expect(mutations[0].key).toMatch(/^[0-9a-f-]{36}$/i);
  expect(mutations[2].key).toMatch(/^[0-9a-f-]{36}$/i);
  expect(mutations[3].key).toMatch(/^[0-9a-f-]{36}$/i);
  expect(
    mutations.every(
      (mutation) =>
        mutation.authorization === 'Bearer participant-callsign-access-token',
    ),
  ).toBe(true);
});

test('keeps a successful callsign save distinct from a failed profile refresh', async ({
  page,
}) => {
  const account = {
    id: 'participant-2',
    email: 'operator2@example.test',
    displayName: 'Operator Two',
    primaryCallsignId: null,
    callsigns: [] as Array<Record<string, unknown>>,
    profileImage: null,
  };
  const callsignRequests: Array<{
    body: unknown;
    idempotencyKey: string;
  }> = [];
  let mutationApplied = false;
  let failProfileRefresh = true;

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === '/v1/programmes') {
      await route.fulfill({ json: { items: [], nextPage: null } });
      return;
    }

    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'participant-callsign-access-token',
          refreshToken: 'participant-callsign-refresh-token',
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me' && method === 'GET') {
      if (mutationApplied && failProfileRefresh) {
        failProfileRefresh = false;
        await route.fulfill({
          status: 503,
          json: { message: 'Profile refresh temporarily unavailable.' },
        });
      } else {
        await route.fulfill({ json: account });
      }
      return;
    }

    if (
      url.pathname === '/v1/identity/accounts/participant-2/callsigns' &&
      method === 'POST'
    ) {
      callsignRequests.push({
        body: request.postDataJSON(),
        idempotencyKey: request.headers()['idempotency-key'] || '',
      });
      account.callsigns.push({
        id: 'callsign-new',
        value: 'DL2NEW',
        status: 'UNVERIFIED',
        evidenceIds: [],
      });
      mutationApplied = true;
      await route.fulfill({ status: 201, json: account });
      return;
    }

    await route.fulfill({
      json: { items: [], page: 1, total: 0, nextPage: null },
    });
  });

  await page.goto('http://127.0.0.1:8091');
  await page.locator('#award-email').fill('operator2@example.test');
  await page.locator('#award-password').fill('test-password');
  await page.locator('#award-login button[type="submit"]').click();
  await expect(page.locator('#profile-callsigns')).toBeVisible();

  await page.locator('#profile-callsign-value').fill('DL2NEW');
  await page.locator('#profile-callsign-add button[type="submit"]').click();
  await expect(page.locator('#profile-status')).toHaveText(
    'Callsign added. Profile refresh failed: Profile refresh temporarily unavailable. Reload the profile to confirm the latest state.',
  );
  expect(callsignRequests).toEqual([
    {
      body: { callsign: 'DL2NEW' },
      idempotencyKey: expect.any(String),
    },
  ]);
  expect(callsignRequests[0].idempotencyKey).not.toBe('');

  await page.reload();
  await expect(
    page.locator('.profile-callsign-row').filter({ hasText: 'DL2NEW' }),
  ).toBeVisible();
  await expect(page.locator('#profile-status')).toHaveText('Profile loaded.');
});
