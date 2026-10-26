import { expect, test } from '@playwright/test';

test('participant registration, resend, verification, sign-in, and sign-out are explicit', async ({
  page,
}) => {
  const requests: Array<{ path: string; body: unknown }> = [];
  let verified = false;
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.method() === 'GET' ? null : request.postDataJSON();
    requests.push({ path: url.pathname, body });

    if (url.pathname === '/v1/identity/auth/register') {
      await route.fulfill({
        json: {
          message:
            'If registration can proceed, a verification email will be sent.',
        },
      });
      return;
    }
    if (url.pathname === '/v1/identity/auth/register/resend') {
      await route.fulfill({
        json: {
          message:
            'If registration can proceed, a verification email will be sent.',
        },
      });
      return;
    }
    if (url.pathname === '/v1/identity/auth/register/verify') {
      verified = true;
      await route.fulfill({
        json: { message: 'Email verified. You can now sign in.' },
      });
      return;
    }
    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'participant-access',
          refreshToken: 'participant-refresh',
        },
      });
      return;
    }
    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'participant-1',
          displayName: 'Casey Operator',
          email: 'casey@example.test',
          status: 'ACTIVE',
          roles: [{ role: 'PARTICIPANT', scopes: [] }],
          callsigns: [],
        },
      });
      return;
    }
    if (url.pathname === '/v1/identity/auth/logout') {
      await route.fulfill({ json: { message: 'Logged out' } });
      return;
    }
    if (url.pathname === '/v1/identity/me/profile-image') {
      await route.fulfill({
        status: 404,
        json: { message: 'No profile image' },
      });
      return;
    }
    await route.fulfill({
      json: { items: [], page: 1, total: 0, nextPage: null },
    });
  });

  await page.goto('http://127.0.0.1:8091/');
  await page.locator('#participant-register-details > summary').click();
  await page.getByLabel('Display name').fill('Casey Operator');
  await page.locator('#register-email').fill('casey@example.test');
  await page.locator('#register-password').fill('long-enough-test-password');
  await page
    .getByRole('button', { name: 'Create account and send verification email' })
    .click();
  await expect(
    page.getByText(
      'If registration can proceed, a verification email will be sent.',
    ),
  ).toBeVisible();
  expect(
    requests.find((request) => request.path === '/v1/identity/auth/register')
      ?.body,
  ).toEqual({
    displayName: 'Casey Operator',
    email: 'casey@example.test',
    password: 'long-enough-test-password',
    participationType: 'OPERATOR',
  });

  await page.locator('#participant-resend-details > summary').click();
  await page.locator('#resend-email').fill('casey@example.test');
  await page
    .getByRole('button', { name: 'Resend verification email' })
    .last()
    .click();
  await page.goto('http://127.0.0.1:8091/?token=single-use-test-token');
  await expect(
    page.getByText('Email verified. You can now sign in.'),
  ).toBeVisible();
  expect(verified).toBe(true);
  expect(new URL(page.url()).searchParams.has('token')).toBe(false);

  await page
    .getByLabel('Email', { exact: true })
    .first()
    .fill('casey@example.test');
  await page
    .getByLabel('Password', { exact: true })
    .first()
    .fill('long-enough-test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(/Signed in as Casey Operator/)).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('You have signed out.')).toBeVisible();
  expect(
    requests.some((request) => request.path === '/v1/identity/auth/logout'),
  ).toBe(true);
});
