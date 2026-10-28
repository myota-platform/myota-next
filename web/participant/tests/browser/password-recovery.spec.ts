import { expect, test } from '@playwright/test';

test('participant can request a password reset without account disclosure', async ({
  page,
}) => {
  let requestBody: unknown;
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    if (
      new URL(request.url()).pathname === '/v1/identity/auth/recovery/request'
    )
      requestBody = request.postDataJSON();
    await route.fulfill({
      json: { status: 'accepted' },
    });
  });

  await page.goto('http://127.0.0.1:8091/');
  await page.locator('#participant-recovery-request-details > summary').click();
  await page.locator('#recovery-email').fill('unknown@example.test');
  await page.getByRole('button', { name: 'Email me a reset link' }).click();

  await expect(page.locator('#participant-recovery-status')).toHaveText(
    'If an account matches that address, a password reset link will be sent by email.',
  );
  expect(requestBody).toEqual({ email: 'unknown@example.test' });
});

test('reset-link token is removed from the URL before browser assets load', async ({
  page,
}) => {
  let resetBody: unknown;
  let appReferer = '';
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/app.js')
      appReferer = request.headers().referer || '';
  });
  await page.route('**/v1/**', async (route) => {
    if (
      new URL(route.request().url()).pathname ===
      '/v1/identity/auth/recovery/reset'
    )
      resetBody = route.request().postDataJSON();
    await route.fulfill({ json: { status: 'password_reset' } });
  });

  await page.goto(
    'http://127.0.0.1:8091/#resetToken=single-use-reset-test-token',
  );
  await expect(page).toHaveURL('http://127.0.0.1:8091/');
  await expect(page.locator('#participant-recovery-reset')).toBeVisible();
  expect(appReferer).not.toContain('single-use-reset-test-token');
  await page
    .locator('#recovery-new-password')
    .fill('new-participant-password-2026!');
  await page.getByRole('button', { name: 'Set new password' }).click();

  await expect(page.locator('#participant-auth-status')).toHaveText(
    'Password updated. Sign in with your new password.',
  );
  expect(resetBody).toEqual({
    token: 'single-use-reset-test-token',
    newPassword: 'new-participant-password-2026!',
  });
  await expect(page.locator('#participant-recovery-reset')).toBeHidden();
});

test('expired reset link offers a recoverable request path', async ({
  page,
}) => {
  await page.route('**/v1/**', async (route) => {
    if (
      new URL(route.request().url()).pathname ===
      '/v1/identity/auth/recovery/reset'
    ) {
      await route.fulfill({
        status: 400,
        json: { message: 'recovery token is invalid or expired' },
      });
      return;
    }
    await route.fulfill({ json: { items: [], page: 1, total: 0 } });
  });

  await page.goto('http://127.0.0.1:8091/#resetToken=expired-reset-token');
  await page
    .locator('#recovery-new-password')
    .fill('new-participant-password-2026!');
  await page.getByRole('button', { name: 'Set new password' }).click();

  await expect(page.locator('#participant-recovery-status')).toHaveText(
    'This reset link is invalid or expired. Request a new link by email.',
  );
  await expect(
    page.locator('#participant-recovery-request-details'),
  ).toBeVisible();
});

test('email change links confirm one address and remove the token before asset requests', async ({
  page,
}) => {
  let verificationBody: unknown;
  let appReferer = '';
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/app.js')
      appReferer = request.headers().referer || '';
  });
  await page.route('**/v1/**', async (route) => {
    if (
      new URL(route.request().url()).pathname ===
      '/v1/identity/auth/email-change/verify'
    ) {
      verificationBody = route.request().postDataJSON();
      await route.fulfill({ json: { status: 'one_address_verified' } });
      return;
    }
    await route.fulfill({ json: { items: [], page: 1, total: 0 } });
  });

  await page.goto(
    'http://127.0.0.1:8091/#emailChangeToken=opaque-email-change-token',
  );
  await expect(page).toHaveURL('http://127.0.0.1:8091/');
  await expect(
    page.locator('#participant-email-change-link-status'),
  ).toHaveText(
    'This address is confirmed. The email change will finish after the other address is confirmed.',
  );
  expect(appReferer).not.toContain('opaque-email-change-token');
  expect(verificationBody).toEqual({ token: 'opaque-email-change-token' });
});

test('signed-in participant can request a double-verified email change', async ({
  page,
}) => {
  let changeBody: unknown;
  let resendCalls = 0;
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
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
          email: 'old@example.test',
          displayName: 'Casey Participant',
          callsigns: [],
          profileImage: null,
        },
      });
      return;
    }
    if (
      url.pathname === '/v1/identity/me/email-change' &&
      request.method() === 'POST'
    ) {
      changeBody = request.postDataJSON();
      await route.fulfill({ json: { status: 'verification_required' } });
      return;
    }
    if (url.pathname === '/v1/identity/me/email-change/resend') {
      resendCalls += 1;
      await route.fulfill({ json: { status: 'verification_resent' } });
      return;
    }
    if (url.pathname === '/v1/identity/me/email-change') {
      await route.fulfill({
        json: {
          pending: {
            id: 'change-1',
            currentEmail: 'old@example.test',
            newEmail: 'new@example.test',
            oldAddressVerified: false,
            newAddressVerified: false,
            expiresAt: '2026-10-28T00:00:00.000Z',
          },
        },
      });
      return;
    }
    await route.fulfill({
      json: { items: [], page: 1, total: 0, nextPage: null },
    });
  });

  await page.goto('http://127.0.0.1:8091/');
  await page.locator('#award-email').fill('old@example.test');
  await page.locator('#award-password').fill('current-participant-password');
  await page.locator('#participant-login button[type="submit"]').click();
  await expect(page.locator('#profile-email-change')).toBeVisible();
  await page
    .locator('#email-change-password')
    .fill('current-participant-password');
  await page.locator('#email-change-new-email').fill('new@example.test');
  await page
    .getByRole('button', { name: 'Send confirmation emails', exact: true })
    .click();

  await expect(page.locator('#profile-email-change-status')).toContainText(
    'Current address confirmed: no; new address confirmed: no',
  );
  expect(changeBody).toEqual({
    currentPassword: 'current-participant-password',
    newEmail: 'new@example.test',
  });

  await page
    .getByRole('button', { name: 'Resend confirmation emails' })
    .click();
  await expect(page.locator('#profile-email-change-status')).toContainText(
    'Earlier links are invalid; confirm both new links.',
  );
  expect(resendCalls).toBe(1);
});
