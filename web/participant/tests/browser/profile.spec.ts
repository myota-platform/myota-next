import { expect, test } from '@playwright/test';
import { expectResponsiveAccessible } from '../../../a11y';

test('edits profile details and renders biography Markdown safely', async ({
  page,
}) => {
  const profileUpdates: Array<{
    authorization: string;
    body: { websiteUrl: string | null; biographyMarkdown: string | null };
  }> = [];
  const biography =
    '**Field operator**\n\n[Radio site](https://radio.example.test) <img src=x onerror=alert(1)>';

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === '/v1/programmes') {
      await route.fulfill({
        json: {
          items: [
            {
              slug: 'alpine',
              name: 'Alpine Summits',
              description: 'Radio from the high country.',
              theme: { primary: '#2367a8', accent: '#e38a32' },
              rules: {
                minimumQsos: { activation: 4, hunter: 1 },
                publicAccessRequired: true,
              },
              entityTypes: [],
            },
          ],
          nextPage: null,
        },
      });
      return;
    }

    if (url.pathname.endsWith('/content')) {
      await route.fulfill({ json: { items: [] } });
      return;
    }

    if (url.pathname === '/v1/geodata/entities') {
      await route.fulfill({
        json: { items: [], page: 1, total: 0, nextPage: null },
      });
      return;
    }

    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'participant-profile-access-token',
          refreshToken: 'participant-profile-refresh-token',
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'participant-1',
          email: 'operator@example.test',
          displayName: 'Operator One',
          websiteUrl: 'https://old.example.test',
          biographyMarkdown: 'Old biography',
          callsigns: [],
          profileImage: null,
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me/profile' && method === 'PATCH') {
      profileUpdates.push({
        authorization: request.headers().authorization || '',
        body: request.postDataJSON() as {
          websiteUrl: string | null;
          biographyMarkdown: string | null;
        },
      });
      await route.fulfill({ json: profileUpdates.at(-1)?.body });
      return;
    }

    await route.fulfill({ json: { items: [], nextPage: null, total: 0 } });
  });

  await page.goto('http://127.0.0.1:8091');
  await page.locator('#award-email').fill('operator@example.test');
  await page.locator('#award-password').fill('test-password');
  await page.locator('#participant-login button[type="submit"]').click();
  await expect(page.locator('#profile-form')).toBeVisible();
  await expect(page.locator('#profile-website')).toHaveValue(
    'https://old.example.test',
  );

  await page.locator('#profile-website').fill(' https://radio.example.test ');
  await page.locator('#profile-biography').fill(biography);
  const preview = page.locator('#profile-biography-preview');
  await expect(preview.locator('strong')).toHaveText('Field operator');
  await expect(
    preview.getByRole('link', { name: 'Radio site' }),
  ).toHaveAttribute('href', 'https://radio.example.test/');
  await expect(preview.locator('img')).toHaveCount(0);
  await expect(preview).toContainText('<img src=x onerror=alert(1)>');

  await page.getByRole('button', { name: 'Save profile details' }).click();
  await expect(page.locator('#profile-status')).toHaveText('Profile saved.');
  expect(profileUpdates).toEqual([
    {
      authorization: 'Bearer participant-profile-access-token',
      body: {
        websiteUrl: 'https://radio.example.test',
        biographyMarkdown: biography,
      },
    },
  ]);
  await expectResponsiveAccessible(page, 'Participant profile editing');
});
