import { expect, test, type Page } from '@playwright/test';

const participant = {
  id: 'participant-session-test',
  displayName: 'Taylor Operator',
  email: 'taylor@example.test',
  status: 'ACTIVE',
  roles: [{ role: 'PARTICIPANT', scopes: [] }],
  callsigns: [],
};

async function signIn(page: Page) {
  await page.locator('#award-email').fill('taylor@example.test');
  await page.locator('#award-password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('participant account area recovers an expired access token with refresh', async ({
  page,
}) => {
  let meRequests = 0;
  let refreshRequests = 0;
  const meAuthorization: string[] = [];

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === '/v1/programmes') {
      await route.fulfill({
        json: {
          items: [
            {
              slug: 'alpine',
              name: 'Alpine Summits',
              description: 'Radio from the high country.',
              rules: { minimumQsos: { activation: 4, hunter: 1 } },
              entityTypes: [],
            },
          ],
          nextPage: null,
        },
      });
      return;
    }
    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'participant-old-access',
          refreshToken: 'participant-refresh',
        },
      });
      return;
    }
    if (url.pathname === '/v1/identity/me') {
      meRequests += 1;
      const authorization = request.headers().authorization || '';
      meAuthorization.push(authorization);
      if (
        meRequests === 2 &&
        authorization === 'Bearer participant-old-access'
      ) {
        await route.fulfill({
          status: 401,
          json: { message: 'Access token expired' },
        });
        return;
      }
      await route.fulfill({ json: participant });
      return;
    }
    if (url.pathname === '/v1/identity/auth/refresh') {
      refreshRequests += 1;
      await route.fulfill({
        json: {
          accessToken: 'participant-new-access',
          refreshToken: 'participant-new-refresh',
        },
      });
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
  await expect(page.locator('#participant-login')).toBeVisible();
  expect(
    await page
      .locator('#participant-login')
      .evaluate((form) =>
        form.closest('section')?.getAttribute('aria-labelledby'),
      ),
  ).toBe('participant-account-heading');
  await signIn(page);

  await expect(page.locator('#profile-status')).toHaveText('Profile loaded.');
  await expect(page.locator('#participant-session-status')).toContainText(
    'Signed in as Taylor Operator',
  );
  await expect(page.locator('#participant-login')).toBeHidden();
  await expect(page.locator('#participant-signout')).toBeVisible();
  expect(refreshRequests).toBe(1);
  expect(meAuthorization).toContain('Bearer participant-new-access');
});

test('participant account returns to sign-in with a clear message after refresh expires', async ({
  page,
}) => {
  let meRequests = 0;

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === '/v1/programmes') {
      await route.fulfill({
        json: {
          items: [
            {
              slug: 'alpine',
              name: 'Alpine Summits',
              description: 'Radio from the high country.',
              rules: { minimumQsos: { activation: 4, hunter: 1 } },
              entityTypes: [],
            },
          ],
          nextPage: null,
        },
      });
      return;
    }
    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'participant-old-access',
          refreshToken: 'participant-refresh',
        },
      });
      return;
    }
    if (url.pathname === '/v1/identity/me') {
      meRequests += 1;
      if (meRequests === 2) {
        await route.fulfill({
          status: 401,
          json: { message: 'Access token expired' },
        });
        return;
      }
      await route.fulfill({ json: participant });
      return;
    }
    if (url.pathname === '/v1/identity/auth/refresh') {
      await route.fulfill({
        status: 401,
        json: { message: 'Refresh token expired' },
      });
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
  await signIn(page);

  await expect(page.locator('#participant-auth-status')).toHaveText(
    'Your session has expired. Please sign in again to continue.',
  );
  await expect(page.locator('#participant-login')).toBeVisible();
  await expect(page.locator('#participant-signout')).toBeHidden();
  await expect(page.locator('#profile-form')).toBeHidden();
  expect(
    await page.evaluate(() => localStorage.getItem('myota_public_access')),
  ).toBeNull();
  expect(
    await page.evaluate(() => localStorage.getItem('myota_public_refresh')),
  ).toBeNull();
});
