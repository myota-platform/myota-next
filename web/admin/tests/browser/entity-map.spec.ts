import { expect, test } from '@playwright/test';
import { expectResponsiveAccessible } from '../../../a11y';

test('explores paged entities and shows the selected map feature details', async ({
  page,
}) => {
  const requestedPages: number[] = [];
  const firstEntity = {
    id: 'summit-1',
    name: 'Summit Alpha',
    status: 'APPROVED',
    entityTypes: [{ code: 'SUMMIT' }],
    programmes: [{ slug: 'summits', name: 'Summits' }],
    location: {
      continent: 'Europe',
      country: 'Spain',
      region: 'Andalusia',
      city: 'Granada',
    },
    geometry: { type: 'Point', coordinates: [-3.6, 37.2] },
  };

  await page.route('https://tile.openstreetmap.org/**', (route) =>
    route.abort(),
  );
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'entity-map-access-token',
          refreshToken: 'entity-map-refresh-token',
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'gis-admin-1',
          email: 'gis-admin@example.test',
          displayName: 'GIS Admin',
          scopes: ['geodata.read'],
        },
      });
      return;
    }

    if (url.pathname === '/v1/geodata/entities') {
      const requestedPage = Number(url.searchParams.get('page'));
      requestedPages.push(requestedPage);
      await route.fulfill({
        json:
          requestedPage === 1
            ? {
                items: [
                  firstEntity,
                  ...Array.from({ length: 99 }, (_, index) => ({
                    id: `entity-${index + 2}`,
                    name: `Entity ${index + 2}`,
                    status: 'APPROVED',
                  })),
                ],
                total: 101,
                page: 1,
                pageSize: 100,
              }
            : {
                items: [
                  {
                    id: 'entity-101',
                    name: 'Summit Beta',
                    status: 'CANDIDATE',
                    geometry: { type: 'Point', coordinates: [-3.7, 37.3] },
                  },
                ],
                total: 101,
                page: 2,
                pageSize: 100,
              },
      });
      return;
    }

    await route.fulfill({ json: { items: [], total: 0, nextPage: null } });
  });

  await page.goto('/entity-map');
  await expect(page).toHaveURL(/\/login\?redirect=\/entity-map$/);
  await page.getByLabel('Email').fill('gis-admin@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/entity-map$/);
  await expect(page.getByText('100 of 101 entities loaded')).toBeVisible();
  await page.locator('.leaflet-marker-icon[title="Summit Alpha"]').click();
  await expect(
    page.getByRole('heading', { name: 'Summit Alpha' }),
  ).toBeVisible();
  await expect(page.getByText('SUMMIT', { exact: true })).toBeVisible();
  await expect(page.getByText('Summits', { exact: true })).toBeVisible();
  await expect(page.getByText('Granada', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Load next 100' }).click();
  await expect(page.getByText('101 of 101 entities loaded')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Summit Alpha' }),
  ).toBeVisible();
  expect(requestedPages).toEqual([1, 2]);

  const directorySummary = page.locator('.entity-map-directory summary');
  await directorySummary.focus();
  await expect(directorySummary).toBeFocused();
  await page.keyboard.press('Enter');
  const betaSelection = page
    .locator('.entity-map-directory')
    .getByRole('button', { name: /Summit Beta/ });
  await betaSelection.focus();
  await expect(betaSelection).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Summit Beta' }),
  ).toBeVisible();
  await expect(betaSelection).toHaveAttribute('aria-pressed', 'true');
  await expectResponsiveAccessible(page, 'Admin entity map exploration');
});
