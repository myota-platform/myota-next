import { expect, test } from '@playwright/test';
import { expectAccessible, expectNoHorizontalOverflow } from '../../../a11y';

const adminRoutes = [
  '/dashboard',
  '/entity-management',
  '/entity-map',
  '/geodata',
  '/geodata-imports',
  '/conflation',
  '/refresh-schedules',
  '/master-data',
  '/programmes',
  '/policies',
  '/content',
  '/awards',
  '/identity',
  '/activity',
];

test('Admin workspaces have accessible names and fit supported viewports', async ({
  page,
}) => {
  test.setTimeout(120_000);

  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'accessibility-admin-access-token',
          refreshToken: 'accessibility-admin-refresh-token',
        },
      });
      return;
    }

    if (path === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'accessibility-admin',
          email: 'accessibility-admin@example.test',
          displayName: 'Accessibility Admin',
          scopes: [
            'programme.admin',
            'geodata.review',
            'geodata.import',
            'identity.admin',
            'identity.accounts.create',
            'identity.roles.manage',
            'activity.read',
            'activity.admin',
            'awards.read',
            'awards.admin',
            'observability.view',
          ],
        },
      });
      return;
    }

    if (path === '/v1/programmes') {
      await route.fulfill({
        json: {
          items: [
            {
              slug: 'alpine',
              name: 'Alpine Summits',
              description: 'Radio from the high country.',
              active: true,
            },
          ],
          nextPage: null,
        },
      });
      return;
    }

    if (path === '/v1/entity-types') {
      await route.fulfill({ json: { items: [], nextPage: null } });
      return;
    }

    await route.fulfill({
      json: { items: [], total: 0, page: 1, nextPage: null },
    });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/dashboard');
  await page.getByLabel('Email').fill('accessibility-admin@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  for (const route of adminRoutes) {
    await page.goto(route);
    await expect(page.locator('#workspace-content')).toBeVisible();

    for (const viewport of [
      { width: 390, height: 844 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await expectNoHorizontalOverflow(
        page,
        `Admin ${route} at ${viewport.width}px`,
      );
      await expectAccessible(page, `Admin ${route} at ${viewport.width}px`);
    }

    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await page.keyboard.press('Tab');
    await expect(page.locator('.skip-link')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#workspace-content')).toBeFocused();
  }
});
